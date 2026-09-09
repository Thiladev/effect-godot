import { Duration, Effect, Exit, Inspectable, Layer, Option, type Pipeable, Queue, type Schema, Stream } from "effect"
import { pipeArguments } from "effect/Pipeable"
import * as Cookies from "effect/unstable/http/Cookies"
import * as Headers from "effect/unstable/http/Headers"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientError from "effect/unstable/http/HttpClientError"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import * as HttpIncomingMessage from "effect/unstable/http/HttpIncomingMessage"
import * as HttpMethod from "effect/unstable/http/HttpMethod"
import * as UrlParams from "effect/unstable/http/UrlParams"
import { HTTPClient as GodotHTTPClient, TLSOptions } from "godot"
import type { PackedByteArray, PackedStringArray } from "godot"

/** The default maximum accumulated response body size. */
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024

/** The default delay between `HTTPClient.poll()` calls while awaiting progress. */
export const DEFAULT_POLL_INTERVAL: Duration.Input = Duration.millis(4)

/**
 * Dependencies needed to construct the Effect `HttpClient` layer.
 *
 * `createClient`/`createTlsOptions` default to a real Godot
 * `HTTPClient`/`TLSOptions.client()`; override either only if you need a
 * fake (e.g. for a test) or non-default TLS trust configuration.
 * `createClient` is a factory rather than a shared instance so every request
 * gets its own connection.
 */
export interface GodotHttpClientOptions {
    readonly createClient?: () => GodotHTTPClient
    /**
     * Godot's `HTTPClient.connect_to_host` only negotiates TLS when given a
     * `TLSOptions` instance, so this defaults to `TLSOptions.client()`
     * rather than silently downgrading `https://` requests to plaintext.
     */
    readonly createTlsOptions?: () => TLSOptions | null
    readonly maxBodyBytes?: number
    readonly readChunkSize?: number
    readonly pollInterval?: Duration.Input
}

const GODOT_OK = 0

const GODOT_STATUS_DISCONNECTED = 0
const GODOT_STATUS_RESOLVING = 1
const GODOT_STATUS_CANT_RESOLVE = 2
const GODOT_STATUS_CONNECTING = 3
const GODOT_STATUS_CANT_CONNECT = 4
const GODOT_STATUS_CONNECTED = 5
const GODOT_STATUS_REQUESTING = 6
const GODOT_STATUS_BODY = 7
const GODOT_STATUS_CONNECTION_ERROR = 8
const GODOT_STATUS_TLS_HANDSHAKE_ERROR = 9

const GODOT_STATUS_AWAITING_CONNECTION: ReadonlySet<number> = new Set([
    GODOT_STATUS_DISCONNECTED,
    GODOT_STATUS_RESOLVING,
    GODOT_STATUS_CONNECTING,
])

const GODOT_STATUS_ERROR_DESCRIPTIONS: Record<number, string> = {
    [GODOT_STATUS_CANT_RESOLVE]: "failed to resolve host",
    [GODOT_STATUS_CANT_CONNECT]: "failed to connect to host",
    [GODOT_STATUS_CONNECTION_ERROR]: "connection error",
    [GODOT_STATUS_TLS_HANDSHAKE_ERROR]: "TLS handshake failed",
}

const GODOT_METHOD: Record<HttpMethod.HttpMethod, GodotHTTPClient.Method> = {
    GET: 0,
    HEAD: 1,
    POST: 2,
    PUT: 3,
    DELETE: 4,
    OPTIONS: 5,
    TRACE: 6,
    PATCH: 8,
}

const normalizeMaxBodyBytes = (value: number | undefined) => {
    const maxBodyBytes = value ?? DEFAULT_MAX_BODY_BYTES

    if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes <= 0) {
        throw new RangeError("maxBodyBytes must be a positive safe integer")
    }

    return maxBodyBytes
}

// -----------------------------------------------------------------------------
// request encoding
// -----------------------------------------------------------------------------

interface EncodedRequestBody {
    readonly body?: string | Uint8Array
    readonly contentType?: string
}

const encodeRequestBody = (
    request: HttpClientRequest.HttpClientRequest,
): Effect.Effect<EncodedRequestBody, HttpClientError.HttpClientError> => {
    const unsupported = (description: string) =>
        Effect.fail(
            new HttpClientError.HttpClientError({
                reason: new HttpClientError.EncodeError({ request, description }),
            }),
        )

    switch (request.body._tag) {
        case "Empty":
            return Effect.succeed({})
        case "Uint8Array":
            return Effect.succeed({
                body: request.body.body,
                contentType: request.body.contentType,
            })
        case "Raw": {
            const { body, contentType } = request.body
            if (typeof body === "string") return Effect.succeed({ body, contentType })
            if (body instanceof Uint8Array) return Effect.succeed({ body, contentType })
            if (body instanceof ArrayBuffer) {
                return Effect.succeed({ body: new Uint8Array(body), contentType })
            }
            return unsupported(
                "GodotHttpClient only supports string and byte-array request bodies",
            )
        }
        case "Stream": {
            // Godot's `HTTPClient.request_raw` takes the whole body in one
            // call; there is no incremental write API for outgoing requests
            // (unlike the response, which is read incrementally through
            // `read_response_body_chunk`). So a streamed body is buffered in
            // full before sending rather than truly streamed.
            const { contentType, stream } = request.body
            return Effect.mapError(
                Effect.map(Stream.runCollect(stream), (chunks) => ({
                    body: concatChunks(chunks as ReadonlyArray<Uint8Array>),
                    contentType,
                })),
                (cause) =>
                    new HttpClientError.HttpClientError({
                        reason: new HttpClientError.EncodeError({
                            request,
                            description: "failed to buffer streaming request body",
                            cause,
                        }),
                    }),
            )
        }
        case "FormData":
            return unsupported("GodotHttpClient does not support multipart request bodies")
    }
}

const toRequestHeaderLines = (
    request: HttpClientRequest.HttpClientRequest,
    body: EncodedRequestBody,
): Array<string> => {
    const headers =
        body.contentType !== undefined && request.headers["content-type"] === undefined
            ? Headers.set(request.headers, "content-type", body.contentType)
            : request.headers

    return Object.entries(headers).map(([name, value]) => `${name}: ${value}`)
}

// -----------------------------------------------------------------------------
// response decoding
// -----------------------------------------------------------------------------

/**
 * There is no `TextDecoder`/`URLSearchParams` in the QuickJS engine GodotJS
 * embeds, so UTF-8 and `x-www-form-urlencoded` decoding are implemented by
 * hand below.
 */
const decodeUtf8 = (bytes: Uint8Array): string => {
    let result = ""

    for (let index = 0; index < bytes.length; ) {
        const byte = bytes[index++]
        if (byte < 0x80) {
            result += String.fromCharCode(byte)
            continue
        }

        const length = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1
        if (length === 1 || index + length - 1 > bytes.length) {
            result += "�"
            continue
        }

        let codePoint = byte & (0xff >> (length + 1))
        let malformed = false
        for (let offset = 1; offset < length; offset++) {
            const continuation = bytes[index++]
            if ((continuation & 0xc0) !== 0x80) {
                malformed = true
                break
            }
            codePoint = (codePoint << 6) | (continuation & 0x3f)
        }

        result += malformed ? "�" : String.fromCodePoint(codePoint)
    }

    return result
}

const decodeUrlEncoded = (text: string): UrlParams.UrlParams => {
    if (text === "") return UrlParams.make([])

    const entries = text.split("&").map((pair): readonly [string, string] => {
        const separator = pair.indexOf("=")
        const key = separator < 0 ? pair : pair.slice(0, separator)
        const value = separator < 0 ? "" : pair.slice(separator + 1)
        return [
            decodeURIComponent(key.replaceAll("+", " ")),
            decodeURIComponent(value.replaceAll("+", " ")),
        ]
    })

    return UrlParams.make(entries)
}

const toResponseHeaders = (lines: readonly string[]): Headers.Headers =>
    Headers.fromInput(
        lines.flatMap((line): Array<readonly [string, string]> => {
            const separator = line.indexOf(":")
            if (separator < 0) return []
            return [[line.slice(0, separator).trim(), line.slice(separator + 1).trim()]]
        }),
    )

const toResponseCookies = (lines: readonly string[]): Cookies.Cookies =>
    Cookies.fromSetCookie(
        lines
            .filter((line) => line.toLowerCase().startsWith("set-cookie:"))
            .map((line) => line.slice(line.indexOf(":") + 1).trim()),
    )

const concatChunks = (chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
    const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
    const result = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) {
        result.set(chunk, offset)
        offset += chunk.byteLength
    }
    return result
}

class GodotClientResponse extends Inspectable.Class
    implements HttpClientResponse.HttpClientResponse, Pipeable.Pipeable {
    readonly [HttpIncomingMessage.TypeId]: typeof HttpIncomingMessage.TypeId =
        HttpIncomingMessage.TypeId
    readonly [HttpClientResponse.TypeId]: typeof HttpClientResponse.TypeId =
        HttpClientResponse.TypeId

    readonly request: HttpClientRequest.HttpClientRequest
    readonly status: number
    private readonly rawHeaders: readonly string[]
    private readonly bodyStream: Stream.Stream<Uint8Array, HttpClientError.HttpClientError>

    constructor(
        request: HttpClientRequest.HttpClientRequest,
        status: number,
        rawHeaders: readonly string[],
        bodyStream: Stream.Stream<Uint8Array, HttpClientError.HttpClientError>,
    ) {
        super()
        this.request = request
        this.status = status
        this.rawHeaders = rawHeaders
        this.bodyStream = bodyStream
    }

    toJSON(): unknown {
        return HttpIncomingMessage.inspect(this, {
            _id: "HttpClientResponse",
            request: this.request.toJSON(),
            status: this.status,
        })
    }

    private cachedHeaders?: Headers.Headers
    get headers(): Headers.Headers {
        return (this.cachedHeaders ??= toResponseHeaders(this.rawHeaders))
    }

    private cachedCookies?: Cookies.Cookies
    get cookies(): Cookies.Cookies {
        return (this.cachedCookies ??= toResponseCookies(this.rawHeaders))
    }

    get remoteAddress(): Option.Option<string> {
        return Option.none()
    }

    /** Single-use, like a Web `ReadableStream` or Node `IncomingMessage`. */
    get stream(): Stream.Stream<Uint8Array, HttpClientError.HttpClientError> {
        return this.bodyStream
    }

    private cachedArrayBuffer?: Effect.Effect<ArrayBuffer, HttpClientError.HttpClientError>
    get arrayBuffer(): Effect.Effect<ArrayBuffer, HttpClientError.HttpClientError> {
        return (this.cachedArrayBuffer ??= Effect.map(
            Stream.runCollect(this.bodyStream),
            (chunks) => concatChunks(chunks).buffer as ArrayBuffer,
        ).pipe(Effect.cached, Effect.runSync))
    }

    private cachedText?: Effect.Effect<string, HttpClientError.HttpClientError>
    get text(): Effect.Effect<string, HttpClientError.HttpClientError> {
        return (this.cachedText ??= Effect.map(this.arrayBuffer, (buffer) => decodeUtf8(new Uint8Array(buffer))))
    }

    get json(): Effect.Effect<Schema.Json, HttpClientError.HttpClientError> {
        return Effect.flatMap(this.text, (text) =>
            Effect.try({
                try: () => (text === "" ? null : JSON.parse(text)),
                catch: (cause) =>
                    new HttpClientError.HttpClientError({
                        reason: new HttpClientError.DecodeError({
                            request: this.request,
                            response: this,
                            description: "failed to decode JSON response",
                            cause,
                        }),
                    }),
            }),
        )
    }

    get urlParamsBody(): Effect.Effect<UrlParams.UrlParams, HttpClientError.HttpClientError> {
        return Effect.map(this.text, decodeUrlEncoded)
    }

    get formData(): Effect.Effect<never, HttpClientError.HttpClientError> {
        return Effect.fail(
            new HttpClientError.HttpClientError({
                reason: new HttpClientError.DecodeError({
                    request: this.request,
                    response: this,
                    description: "GodotHttpClient does not decode multipart form data",
                }),
            }),
        )
    }

    pipe() {
        return pipeArguments(this, arguments)
    }
}

// -----------------------------------------------------------------------------
// transport
// -----------------------------------------------------------------------------

const makeTransportError = (
    request: HttpClientRequest.HttpClientRequest,
    description: string,
    cause?: unknown,
) =>
    new HttpClientError.HttpClientError({
        reason: new HttpClientError.TransportError({ request, description, cause }),
    })

const toBytes = (body: PackedByteArray | Uint8Array): Uint8Array =>
    body instanceof Uint8Array ? body : new Uint8Array(body.to_array_buffer())

const toLines = (headers: PackedStringArray | readonly string[]): Array<string> => {
    if (Array.isArray(headers)) return headers as Array<string>

    const packed = headers as PackedStringArray
    const lines: Array<string> = []
    for (let index = 0; index < packed.size(); index++) lines.push(packed.get(index))
    return lines
}

interface AbortableSignal {
    readonly addEventListener: (
        type: "abort",
        listener: () => void,
        options?: { readonly once?: boolean },
    ) => void
    readonly removeEventListener: (type: "abort", listener: () => void) => void
}

/**
 * Owns one Godot `HTTPClient` connection and its lifetime.
 *
 * `HTTPClient` is a plain `RefCounted`, not a `Node`, so there is no scene
 * tree to detach from: `close()` is the entire teardown, and it doubles as
 * the abort-signal handler so a cancelled request (whether interrupted while
 * awaiting headers or while a caller is still draining the body stream)
 * always releases the connection.
 */
class GodotConnection {
    readonly client: GodotHTTPClient
    private isClosed = false
    private readonly signal: AbortableSignal
    private readonly onAbort = () => this.close()

    constructor(client: GodotHTTPClient, signal: AbortableSignal) {
        this.client = client
        this.signal = signal
        signal.addEventListener("abort", this.onAbort, { once: true })
    }

    get closed(): boolean {
        return this.isClosed
    }

    close(): void {
        if (this.isClosed) return
        this.isClosed = true
        this.signal.removeEventListener("abort", this.onAbort)
        try {
            this.client.close()
        } catch {
            // Best effort; the connection may already be in a terminal state.
        }
    }
}

/** Polls a connection until its status leaves the given set, or fails on a terminal error status. */
const pollUntilStatusIsNot = (
    connection: GodotConnection,
    request: HttpClientRequest.HttpClientRequest,
    pollInterval: Duration.Input,
    waitingStatuses: ReadonlySet<number>,
): Effect.Effect<number, HttpClientError.HttpClientError> =>
    Effect.gen(function* () {
        while (true) {
            connection.client.poll()
            const status = connection.client.get_status()

            const errorDescription = GODOT_STATUS_ERROR_DESCRIPTIONS[status]
            if (errorDescription !== undefined) {
                return yield* Effect.fail(makeTransportError(request, errorDescription, { status }))
            }
            if (!waitingStatuses.has(status)) return status

            yield* Effect.sleep(pollInterval)
        }
    })

/**
 * Streams the response body by repeatedly polling and reading whatever chunk
 * of bytes has arrived so far. The connection is closed as soon as the
 * status leaves `STATUS_BODY` (normal completion), the status becomes an
 * error, the accumulated size exceeds `maxBodyBytes`, or the stream itself is
 * interrupted.
 */
const streamResponseBody = (
    connection: GodotConnection,
    request: HttpClientRequest.HttpClientRequest,
    pollInterval: Duration.Input,
    maxBodyBytes: number,
): Stream.Stream<Uint8Array, HttpClientError.HttpClientError> =>
    Stream.callback<Uint8Array, HttpClientError.HttpClientError>((queue) =>
        Effect.ensuring(
            Effect.gen(function* () {
                let total = 0

                while (true) {
                    if (connection.closed) {
                        return yield* Queue.fail(queue, makeTransportError(request, "Godot HTTP request aborted"))
                    }

                    connection.client.poll()
                    const status = connection.client.get_status()

                    const errorDescription = GODOT_STATUS_ERROR_DESCRIPTIONS[status]
                    if (errorDescription !== undefined) {
                        return yield* Queue.fail(queue, makeTransportError(request, errorDescription, { status }))
                    }

                    const chunk = toBytes(connection.client.read_response_body_chunk())
                    if (chunk.byteLength > 0) {
                        total += chunk.byteLength
                        if (total > maxBodyBytes) {
                            return yield* Queue.fail(
                                queue,
                                makeTransportError(request, `Godot HTTP response exceeded ${maxBodyBytes} bytes`),
                            )
                        }
                        yield* Queue.offer(queue, chunk)
                    }

                    if (status !== GODOT_STATUS_BODY) return yield* Queue.end(queue)

                    if (chunk.byteLength === 0) yield* Effect.sleep(pollInterval)
                }
            }),
            Effect.sync(() => connection.close()),
        ),
    )

/**
 * Runs one request through a Godot `HTTPClient`, connecting, sending the
 * request, and polling for the response headers. `connect_to_host`,
 * `request`/`request_raw`, and the connecting/requesting poll loops are
 * ordinary `Effect`s, so fiber interruption during those phases works
 * without any manual signal plumbing; `Effect.onExit` closes the connection
 * if that setup fails or is interrupted. Once headers arrive, the connection
 * is either closed immediately (no body) or handed to `streamResponseBody`,
 * which owns closing it once the body has been read.
 */
const runGodotRequest = (
    options: GodotHttpClientOptions,
    request: HttpClientRequest.HttpClientRequest,
    url: {
        readonly protocol: string
        readonly hostname: string
        readonly port: string
        readonly pathname: string
        readonly search: string
    },
    signal: AbortableSignal,
    body: EncodedRequestBody,
    maxBodyBytes: number,
    pollInterval: Duration.Input,
): Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError> =>
    Effect.gen(function* () {
        const isHttps = url.protocol === "https:"
        const tlsOptions = isHttps
            ? ((options.createTlsOptions ?? (() => TLSOptions.client()))() ?? undefined)
            : undefined
        if (isHttps && tlsOptions === undefined) {
            return yield* Effect.fail(
                makeTransportError(request, "HTTPS requires a TLSOptions instance, but none was available"),
            )
        }

        const client = (options.createClient ?? (() => new GodotHTTPClient()))()
        const connection = new GodotConnection(client, signal)
        if (options.readChunkSize !== undefined) {
            connection.client.read_chunk_size = options.readChunkSize
        }

        return yield* Effect.onExit(
            Effect.gen(function* () {
                const port = url.port !== "" ? Number(url.port) : isHttps ? 443 : 80
                const connectCode = connection.client.connect_to_host(url.hostname, port, tlsOptions)
                if (connectCode !== GODOT_OK) {
                    return yield* Effect.fail(
                        makeTransportError(
                            request,
                            `Godot HTTPClient could not connect (error ${connectCode})`,
                            { code: connectCode },
                        ),
                    )
                }

                yield* pollUntilStatusIsNot(connection, request, pollInterval, GODOT_STATUS_AWAITING_CONNECTION)

                const headers = toRequestHeaderLines(request, body)
                const method = GODOT_METHOD[request.method]
                const target = url.pathname + url.search
                const requestCode =
                    body.body === undefined || typeof body.body === "string"
                        ? connection.client.request(method, target, headers, body.body)
                        : connection.client.request_raw(method, target, headers, Array.from(body.body))
                if (requestCode !== GODOT_OK) {
                    return yield* Effect.fail(
                        makeTransportError(
                            request,
                            `Godot HTTPClient could not send request (error ${requestCode})`,
                            { code: requestCode },
                        ),
                    )
                }

                const statusAfterRequest = yield* pollUntilStatusIsNot(
                    connection,
                    request,
                    pollInterval,
                    new Set([GODOT_STATUS_REQUESTING]),
                )

                if (!connection.client.has_response()) {
                    return yield* Effect.fail(makeTransportError(request, "Godot HTTPClient request has no response"))
                }

                const status = connection.client.get_response_code()
                const responseHeaders = toLines(connection.client.get_response_headers())

                if (statusAfterRequest !== GODOT_STATUS_BODY) {
                    connection.close()
                    return new GodotClientResponse(request, status, responseHeaders, Stream.empty)
                }

                return new GodotClientResponse(
                    request,
                    status,
                    responseHeaders,
                    streamResponseBody(connection, request, pollInterval, maxBodyBytes),
                )
            }),
            (exit) => (Exit.isFailure(exit) ? Effect.sync(() => connection.close()) : Effect.void),
        )
    })

/** Constructs an Effect `HttpClient` backed by a Godot `HTTPClient` per request. */
export const make = (options: GodotHttpClientOptions = {}): HttpClient.HttpClient => {
    const maxBodyBytes = normalizeMaxBodyBytes(options.maxBodyBytes)
    const pollInterval = options.pollInterval ?? DEFAULT_POLL_INTERVAL

    return HttpClient.make((request, url, signal) =>
        Effect.flatMap(encodeRequestBody(request), (body) =>
            runGodotRequest(options, request, url, signal, body, maxBodyBytes, pollInterval),
        ),
    )
}

/** Provides the current Effect `HttpClient` service using Godot `HTTPClient`, with the given options. */
export const layerWithOptions = (options: GodotHttpClientOptions): Layer.Layer<HttpClient.HttpClient> =>
    Layer.sync(HttpClient.HttpClient, () => make(options))

/** Provides the current Effect `HttpClient` service using Godot `HTTPClient`, with every default. */
export const layer: Layer.Layer<HttpClient.HttpClient> = Layer.sync(HttpClient.HttpClient, () => make())
