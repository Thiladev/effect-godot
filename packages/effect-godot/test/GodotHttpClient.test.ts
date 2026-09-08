import { describe, expect, it } from "bun:test"
import { Effect, Fiber } from "effect"
import * as HttpBody from "effect/unstable/http/HttpBody"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import type { Callable, HTTPRequest } from "godot"
import {
    DEFAULT_MAX_BODY_BYTES,
    GodotHttpClientLayer,
    type GodotHttpClientOptions,
    type GodotHttpRequestCompleted,
} from "../src/index"

type FakeCompletion = (
    result: number,
    status: number,
    headers: readonly string[],
    body: Uint8Array,
) => void

class TestSignal {
    listener: FakeCompletion | undefined

    connect(listener: unknown): number {
        this.listener = listener as FakeCompletion
        return 0
    }

    disconnect(listener: unknown): void {
        if (this.listener === listener) this.listener = undefined
    }

    emit(
        result: number,
        status: number,
        headers: readonly string[],
        body: Uint8Array,
    ): void {
        this.listener?.(result, status, headers, body)
    }
}

class TestRequest {
    readonly request_completed = new TestSignal()
    body_size_limit = 0
    timeout = 0
    max_redirects = 0
    accept_gzip = false
    cancelled = 0
    freed = 0
    readonly stringRequests: Array<{
        url: string
        headers: string[]
        method: number
        body?: string
    }> = []
    readonly rawRequests: Array<{
        url: string
        headers: string[]
        method: number
        body: number[] | ArrayBuffer
    }> = []
    startCode = 0
    onRequest: ((request: TestRequest) => void) | undefined

    request(
        url: string,
        headers: string[],
        method: number,
        body?: string,
    ): number {
        this.stringRequests.push({ url, headers, method, body })
        this.onRequest?.(this)
        return this.startCode
    }

    request_raw(
        url: string,
        headers: string[],
        method: number,
        body: number[] | ArrayBuffer,
    ): number {
        this.rawRequests.push({ url, headers, method, body })
        this.onRequest?.(this)
        return this.startCode
    }

    cancel_request(): void {
        this.cancelled += 1
    }

    queue_free(): void {
        this.freed += 1
    }
}

const optionsFor = (
    request: TestRequest,
    overrides: Partial<GodotHttpClientOptions> = {},
): GodotHttpClientOptions => ({
    parent: {
        add_child: () => undefined,
    } as GodotHttpClientOptions["parent"],
    createRequest: () => request as unknown as HTTPRequest,
    createCallable: (listener: GodotHttpRequestCompleted) =>
        listener as unknown as Callable<GodotHttpRequestCompleted>,
    ...overrides,
})

const get = (request: TestRequest, options?: Partial<GodotHttpClientOptions>) =>
    HttpClient.get("https://example.test/items", {
        headers: { Accept: "application/json" },
    }).pipe(Effect.provide(GodotHttpClientLayer(optionsFor(request, options))))

describe("GodotHttpClient", () => {
    it("provides Effect HttpClient and preserves response data", async () => {
        const request = new TestRequest()
        request.onRequest = (current) => {
            queueMicrotask(() =>
                current.request_completed.emit(
                    0,
                    404,
                    ["Content-Type: application/json", "Set-Cookie: sid=1"],
                    new Uint8Array([123, 34, 111, 107, 34, 58, 116, 114, 117, 101, 125]),
                ),
            )
        }

        const response = await Effect.runPromise(get(request))

        expect(response.status).toBe(404)
        expect(response.headers["content-type"]).toBe("application/json")
        await expect(Effect.runPromise(response.json)).resolves.toEqual({
            ok: true,
        })
        expect(request.body_size_limit).toBe(DEFAULT_MAX_BODY_BYTES)
        expect(request.stringRequests[0]?.url).toBe("https://example.test/items")
        expect(request.stringRequests[0]?.method).toBe(0)
        expect(request.stringRequests[0]?.body).toBeUndefined()
        expect(request.stringRequests[0]?.headers).toContain(
            "accept: application/json",
        )
        expect(request.request_completed.listener).toBeUndefined()
        expect(request.cancelled).toBe(0)
        expect(request.freed).toBe(1)
    })

    it("maps Effect byte bodies to request_raw and enforces the body limit", async () => {
        const request = new TestRequest()
        request.onRequest = (current) => {
            queueMicrotask(() =>
                current.request_completed.emit(
                    0,
                    200,
                    [],
                    new Uint8Array([1, 2, 3]),
                ),
            )
        }

        const program = HttpClient.execute(
            HttpClientRequest.post("https://example.test/upload", {
                body: HttpBody.uint8Array(
                    new Uint8Array([9, 8]),
                    "application/octet-stream",
                ),
            }),
        ).pipe(
            Effect.provide(
                GodotHttpClientLayer(optionsFor(request, { maxBodyBytes: 2 })),
            ),
        )

        await expect(Effect.runPromise(program)).rejects.toMatchObject({
            _tag: "HttpClientError",
            reason: {
                _tag: "TransportError",
            },
        })
        expect(request.body_size_limit).toBe(2)
        expect(request.rawRequests[0]?.url).toBe("https://example.test/upload")
        expect(request.rawRequests[0]?.method).toBe(2)
        expect(request.rawRequests[0]?.body).toEqual([9, 8])
        expect(request.rawRequests[0]?.headers).toContain(
            "content-type: application/octet-stream",
        )
        expect(request.freed).toBe(1)
    })

    it("maps a Godot request start error to HttpClientError", async () => {
        const request = new TestRequest()
        request.startCode = 13

        await expect(Effect.runPromise(get(request))).rejects.toMatchObject({
            _tag: "HttpClientError",
            reason: {
                _tag: "TransportError",
                description: "Godot HTTPRequest could not start (error 13)",
            },
        })
        expect(request.request_completed.listener).toBeUndefined()
        expect(request.cancelled).toBe(1)
        expect(request.freed).toBe(1)
    })

    it("cancels and frees the Godot request when interrupted", async () => {
        const request = new TestRequest()
        const fiber = Effect.runFork(get(request))

        await Effect.runPromise(Fiber.interrupt(fiber))

        expect(request.request_completed.listener).toBeUndefined()
        expect(request.cancelled).toBe(1)
        expect(request.freed).toBe(1)
    })
})
