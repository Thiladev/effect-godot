import { describe, expect, it } from "bun:test"
import { Effect, Fiber, Stream } from "effect"
import * as HttpBody from "effect/unstable/http/HttpBody"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import type { HTTPClient } from "godot"
import {
    DEFAULT_MAX_BODY_BYTES,
    GodotHttpClientLayer,
    type GodotHttpClientOptions,
} from "../src/index"

const GODOT_OK = 0
const STATUS_CONNECTED = 5
const STATUS_REQUESTING = 6
const STATUS_BODY = 7

/**
 * A scripted fake of Godot's low-level `HTTPClient`. `pollScript[n]` is the
 * status returned after the `(n + 1)`th call to `poll()`; once exhausted, the
 * last entry repeats. This mirrors the real class closely enough to drive
 * `GodotHttpClient`'s connect -> request -> poll-for-headers -> poll-for-body
 * state machine without a real socket.
 */
class TestHttpClient {
    connectResult = GODOT_OK
    requestResult = GODOT_OK
    connectCalls: Array<{ host: string; port: number; tlsOptions: unknown }> = []
    requests: Array<{ method: number; target: string; headers: string[]; body?: string }> = []
    rawRequests: Array<{ method: number; target: string; headers: string[]; body: number[] }> = []
    responseCode = 200
    responseHeaders: string[] = []
    pollScript: number[] = [STATUS_CONNECTED]
    chunks: Uint8Array[] = []
    read_chunk_size = 0
    closed = 0

    private pollCount = 0
    private chunkIndex = 0

    connect_to_host(host: string, port: number, tlsOptions?: unknown): number {
        this.connectCalls.push({ host, port, tlsOptions })
        return this.connectResult
    }

    poll(): number {
        if (this.pollCount < this.pollScript.length - 1) this.pollCount += 1
        return GODOT_OK
    }

    get_status(): number {
        return this.pollScript[Math.min(this.pollCount, this.pollScript.length - 1)]
    }

    request(method: number, target: string, headers: string[], body?: string): number {
        this.requests.push({ method, target, headers, body })
        return this.requestResult
    }

    request_raw(method: number, target: string, headers: string[], body: number[]): number {
        this.rawRequests.push({ method, target, headers, body })
        return this.requestResult
    }

    has_response(): boolean {
        return true
    }

    get_response_code(): number {
        return this.responseCode
    }

    get_response_headers(): string[] {
        return this.responseHeaders
    }

    read_response_body_chunk(): Uint8Array {
        return this.chunks[this.chunkIndex++] ?? new Uint8Array(0)
    }

    close(): void {
        this.closed += 1
    }
}

const optionsFor = (
    client: TestHttpClient,
    overrides: Partial<GodotHttpClientOptions> = {},
): GodotHttpClientOptions => ({
    createClient: () => client as unknown as HTTPClient,
    pollInterval: 1,
    ...overrides,
})

const get = (client: TestHttpClient, options?: Partial<GodotHttpClientOptions>) =>
    HttpClient.get("http://example.test/items", {
        headers: { Accept: "application/json" },
    }).pipe(Effect.provide(GodotHttpClientLayer(optionsFor(client, options))))

const jsonBytes = new TextEncoder().encode('{"ok":true}')

describe("GodotHttpClient", () => {
    it("provides Effect HttpClient and preserves response data", async () => {
        const client = new TestHttpClient()
        client.responseCode = 404
        client.responseHeaders = ["Content-Type: application/json", "Set-Cookie: sid=1"]
        client.pollScript = [STATUS_CONNECTED, STATUS_REQUESTING, STATUS_BODY, STATUS_BODY, STATUS_CONNECTED]
        client.chunks = [jsonBytes.slice(0, 6), jsonBytes.slice(6)]

        const response = await Effect.runPromise(get(client))

        expect(response.status).toBe(404)
        expect(response.headers["content-type"]).toBe("application/json")
        await expect(Effect.runPromise(response.json)).resolves.toEqual({ ok: true })

        expect(client.connectCalls[0]).toEqual({ host: "example.test", port: 80, tlsOptions: undefined })
        expect(client.requests[0]?.target).toBe("/items")
        expect(client.requests[0]?.method).toBe(0)
        expect(client.requests[0]?.body).toBeUndefined()
        expect(client.requests[0]?.headers).toContain("accept: application/json")
        expect(client.closed).toBe(1)
    })

    it("maps Effect byte bodies to request_raw and enforces the body limit", async () => {
        const client = new TestHttpClient()
        client.pollScript = [STATUS_CONNECTED, STATUS_REQUESTING, STATUS_BODY]
        client.chunks = [new Uint8Array([1, 2, 3])]

        const program = HttpClient.execute(
            HttpClientRequest.post("http://example.test/upload", {
                body: HttpBody.uint8Array(new Uint8Array([9, 8]), "application/octet-stream"),
            }),
        ).pipe(
            // The body limit is only enforced once something reads the
            // (lazy, streaming) response body.
            Effect.flatMap((response) => response.arrayBuffer),
            Effect.provide(GodotHttpClientLayer(optionsFor(client, { maxBodyBytes: 1 }))),
        )

        await expect(Effect.runPromise(program)).rejects.toMatchObject({
            _tag: "HttpClientError",
            reason: { _tag: "TransportError" },
        })
        expect(client.rawRequests[0]?.target).toBe("/upload")
        expect(client.rawRequests[0]?.method).toBe(2)
        expect(client.rawRequests[0]?.body).toEqual([9, 8])
        expect(client.rawRequests[0]?.headers).toContain("content-type: application/octet-stream")
        expect(client.closed).toBe(1)
    })

    it("buffers a streamed request body before sending it via request_raw", async () => {
        const client = new TestHttpClient()
        client.pollScript = [STATUS_CONNECTED, STATUS_REQUESTING, STATUS_BODY, STATUS_CONNECTED]

        const program = HttpClient.execute(
            HttpClientRequest.post("http://example.test/upload", {
                body: HttpBody.stream(
                    Stream.fromIterable([new Uint8Array([1, 2]), new Uint8Array([3, 4])]),
                    "application/octet-stream",
                ),
            }),
        ).pipe(Effect.provide(GodotHttpClientLayer(optionsFor(client))))

        const response = await Effect.runPromise(program)

        expect(response.status).toBe(200)
        expect(client.rawRequests[0]?.body).toEqual([1, 2, 3, 4])
        expect(client.rawRequests[0]?.headers).toContain("content-type: application/octet-stream")
    })

    it("maps a Godot connect failure to HttpClientError", async () => {
        const client = new TestHttpClient()
        client.connectResult = 13

        await expect(Effect.runPromise(get(client))).rejects.toMatchObject({
            _tag: "HttpClientError",
            reason: {
                _tag: "TransportError",
                description: "Godot HTTPClient could not connect (error 13)",
            },
        })
        expect(client.closed).toBe(1)
    })

    it("closes the connection when interrupted while awaiting a connection", async () => {
        const client = new TestHttpClient()
        client.pollScript = [1 /* STATUS_RESOLVING, never resolves */]

        const fiber = Effect.runFork(get(client))
        await new Promise((resolve) => setTimeout(resolve, 10))
        await Effect.runPromise(Fiber.interrupt(fiber))

        expect(client.closed).toBe(1)
    })
})
