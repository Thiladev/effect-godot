import { Array, Effect, Exit, Inspectable, Layer, Option, Pipeable, Queue, Ref, type Schema, Stream } from "effect"
import { Cookies, Headers, HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse, HttpIncomingMessage, HttpMethod, UrlParams } from "effect/unstable/http"
import { Callable, Engine, HTTPClient as GodotHTTPClient, TLSOptions } from "godot"
import type { PackedByteArray, PackedStringArray, SceneTree } from "godot"
import * as GodotConnectionPool from "./GodotConnectionPool"


const textDecoder = new TextDecoder()

/** The default maximum accumulated response body size. */
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024

/**
 * Dependencies needed to construct the Effect `HttpClient` layer.
 *
 * `createClient`/`createTlsOptions` default to a real Godot
 * `HTTPClient`/`TLSOptions.client()`; override either only if you need a
 * fake (e.g. for a test) or non-default TLS trust configuration.
 *
 * With the default `createClient`, `layer`/`layerWithOptions` pool and reuse
 * connections per host across requests, per Godot's own guidance ("An
 * HTTPClient should be reused between multiple requests... instead of
 * creating one client per request") — see `layer`'s doc. Passing a custom
 * `createClient` opts out of pooling entirely: it's always called fresh, one
 * connection per request, which is what keeps it safe to use for injecting a
 * per-request test double.
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
            return Stream.runCollect(stream).pipe(
                Effect.map((chunks) => ({
                    body: concatChunks(chunks as ReadonlyArray<Uint8Array>),
                    contentType,
                })),
                Effect.mapError(
                    (cause) =>
                        new HttpClientError.HttpClientError({
                            reason: new HttpClientError.EncodeError({
                                request,
                                description: "failed to buffer streaming request body",
                                cause,
                            }),
                        }),
                ),
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

const decodeUrlEncoded = (text: string): UrlParams.UrlParams => UrlParams.fromInput(new URLSearchParams(text))

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
    const [length, offsets] = Array.mapAccum(chunks, 0, (offset, chunk) => [offset + chunk.byteLength, offset] as const)
    const result = new Uint8Array(length)
    Array.forEach(Array.zip(chunks, offsets), ([chunk, offset]) => result.set(chunk, offset))
    return result
}

class GodotClientResponse extends Inspectable.Class
implements HttpClientResponse.HttpClientResponse, Pipeable.Pipeable {
    readonly [HttpIncomingMessage.TypeId]: typeof HttpIncomingMessage.TypeId = HttpIncomingMessage.TypeId
    readonly [HttpClientResponse.TypeId]: typeof HttpClientResponse.TypeId = HttpClientResponse.TypeId

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
        return (this.cachedArrayBuffer ??= Stream.runCollect(this.bodyStream).pipe(
            Effect.map((chunks) => concatChunks(chunks).buffer as ArrayBuffer),
            Effect.cached,
            Effect.runSync,
        ))
    }

    private cachedText?: Effect.Effect<string, HttpClientError.HttpClientError>
    get text(): Effect.Effect<string, HttpClientError.HttpClientError> {
        return (this.cachedText ??= this.arrayBuffer.pipe(
            Effect.map((buffer) => textDecoder.decode(new Uint8Array(buffer))),
        ))
    }

    get json(): Effect.Effect<Schema.Json, HttpClientError.HttpClientError> {
        return this.text.pipe(
            Effect.flatMap((text) =>
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
            ),
        )
    }

    get urlParamsBody(): Effect.Effect<UrlParams.UrlParams, HttpClientError.HttpClientError> {
        return this.text.pipe(Effect.map(decodeUrlEncoded))
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
        return Pipeable.pipeArguments(this, arguments)
    }

    toJSON(): unknown {
        return HttpIncomingMessage.inspect(this, {
            _id: "HttpClientResponse",
            request: this.request.toJSON(),
            status: this.status,
        })
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

/**
 * Waits for the next `SceneTree.process_frame` signal, used to pace polling
 * to the engine's own frame loop instead of an independent timer — matching
 * Godot's own canonical `HTTPClient` usage pattern (`await
 * get_tree().process_frame` in the GDScript docs sample), rather than the
 * ~125x-more-frequent fixed-millisecond polling this used before.
 *
 * `Engine.get_main_loop()` is a plain static accessor reachable from
 * anywhere — "usually the main `SceneTree` and the same as
 * `Node.get_tree()`" — so no node reference or Effect service is needed to
 * reach it. Real `Signal.connect` takes a `Callable`, not a plain function,
 * hence the wrap/unwrap.
 */
const nextProcessFrame = (
    request: HttpClientRequest.HttpClientRequest,
): Effect.Effect<void, HttpClientError.HttpClientError> =>
    Effect.gen(function* () {
        const mainLoop = Engine.get_main_loop()
        if (mainLoop === null || !("process_frame" in mainLoop)) {
            return yield* Effect.fail(
                makeTransportError(
                    request,
                    "Godot HTTPClient polling requires an active SceneTree (Engine.get_main_loop())",
                ),
            )
        }

        const processFrame = (mainLoop as SceneTree).process_frame

        yield* Effect.callback<void>((resume) => {
            let active = true
            let callable: Callable<() => void>

            const listener = () => {
                if (!active) return
                active = false
                processFrame.disconnect(callable)
                resume(Effect.void)
            }

            callable = Callable.create(listener)
            processFrame.connect(callable)

            return Effect.sync(() => {
                if (!active) return
                active = false
                processFrame.disconnect(callable)
            })
        })
    })

const toBytes = (body: PackedByteArray | Uint8Array): Uint8Array =>
    body instanceof Uint8Array ? body : new Uint8Array(body.to_array_buffer())

const toLines = (headers: PackedStringArray | readonly string[]): Array<string> => {
    if (globalThis.Array.isArray(headers)) return headers as Array<string>

    const packed = headers as PackedStringArray
    return Array.makeBy(packed.size(), (index) => packed.get(index))
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
 * Owns one checkout of a Godot `HTTPClient` connection.
 *
 * `HTTPClient` is a plain `RefCounted`, not a `Node`, so there is no scene
 * tree to detach from. `discard`/`release` double as the abort-signal
 * handler (always discarding) so a cancelled request — whether interrupted
 * while awaiting headers or while a caller is still draining the body
 * stream — always ends the checkout.
 *
 * Whether this checkout has ended lives in a `Ref` rather than a plain
 * mutable field, so `discard`/`release` (each idempotent: only the first
 * caller of either actually does anything) are ordinary `Effect`s instead of
 * side-effecting methods — the abort-signal listener is the one place that
 * still has to reach into the `Effect` world imperatively, via `runSync`,
 * since a DOM-style event listener has no way to `yield*`.
 */
interface GodotConnection {
    readonly client: GodotHTTPClient
    readonly closed: Effect.Effect<boolean>
    /** Ends this checkout, permanently closing the underlying connection. */
    readonly discard: Effect.Effect<void>
    /**
     * Ends this checkout. Returns the connection to the pool for reuse if
     * one was provided and the connection is still healthy; otherwise this
     * is the same as `discard`.
     */
    readonly release: Effect.Effect<void>
}

const makeConnection = (
    client: GodotHTTPClient,
    signal: AbortableSignal,
    pool: GodotConnectionPool.GodotConnectionPoolShape | undefined,
    hostKey: string,
): Effect.Effect<GodotConnection> =>
    Effect.map(Ref.make(false), (isClosed) => {
        const onAbort = () => Effect.runSync(discard)

        const discard: Effect.Effect<void> = Effect.gen(function* () {
            const wasClosed = yield* Ref.getAndSet(isClosed, true)
            if (wasClosed) return
            signal.removeEventListener("abort", onAbort)
            GodotConnectionPool.closeQuietly(client)
        })

        const release: Effect.Effect<void> = Effect.gen(function* () {
            if (pool === undefined || client.get_status() !== GODOT_STATUS_CONNECTED) {
                return yield* discard
            }

            const wasClosed = yield* Ref.getAndSet(isClosed, true)
            if (wasClosed) return
            signal.removeEventListener("abort", onAbort)
            yield* pool.release(hostKey, client)
        })

        signal.addEventListener("abort", onAbort, { once: true })

        return { client, closed: Ref.get(isClosed), discard, release }
    })

/**
 * Polls a connection until its status leaves the given set, or fails on a
 * terminal error status. Recurses through `nextProcessFrame` rather than a
 * `while (true)` loop — each iteration is already paced to a real
 * `process_frame` signal, so there's no busy-spin risk making a manual loop
 * necessary, and the tail call keeps this stack-safe.
 */
const pollUntilStatusIsNot = (
    connection: GodotConnection,
    request: HttpClientRequest.HttpClientRequest,
    waitingStatuses: ReadonlySet<number>,
): Effect.Effect<number, HttpClientError.HttpClientError> =>
    Effect.gen(function* () {
        connection.client.poll()
        const status = connection.client.get_status()

        const errorDescription = GODOT_STATUS_ERROR_DESCRIPTIONS[status]
        if (errorDescription !== undefined) {
            return yield* Effect.fail(makeTransportError(request, errorDescription, { status }))
        }
        if (!waitingStatuses.has(status)) return status

        yield* nextProcessFrame(request)
        return yield* pollUntilStatusIsNot(connection, request, waitingStatuses)
    })

/**
 * Streams the response body by repeatedly polling and reading whatever chunk
 * of bytes has arrived so far. The connection is released back to its pool
 * (if any) as soon as the status leaves `STATUS_BODY` normally; it's
 * discarded outright on error, on exceeding `maxBodyBytes`, or if the stream
 * itself is interrupted.
 */
const streamResponseBody = (
    connection: GodotConnection,
    request: HttpClientRequest.HttpClientRequest,
    maxBodyBytes: number,
): Stream.Stream<Uint8Array, HttpClientError.HttpClientError> =>
    Stream.callback<Uint8Array, HttpClientError.HttpClientError>((queue) => {
        // Recurses through `nextProcessFrame` instead of a `while (true)`
        // loop, carrying the running byte total as a parameter rather than a
        // mutable variable — same reasoning as `pollUntilStatusIsNot`.
        const pump = (total: number): Effect.Effect<void, HttpClientError.HttpClientError> =>
            Effect.gen(function* () {
                if (yield* connection.closed) {
                    yield* Queue.fail(queue, makeTransportError(request, "Godot HTTP request aborted"))
                    return
                }

                connection.client.poll()
                const status = connection.client.get_status()

                const errorDescription = GODOT_STATUS_ERROR_DESCRIPTIONS[status]
                if (errorDescription !== undefined) {
                    yield* connection.discard
                    yield* Queue.fail(queue, makeTransportError(request, errorDescription, { status }))
                    return
                }

                if (status !== GODOT_STATUS_BODY) {
                    yield* connection.release
                    yield* Queue.end(queue)
                    return
                }

                const chunk = toBytes(connection.client.read_response_body_chunk())
                if (chunk.byteLength === 0) {
                    yield* nextProcessFrame(request)
                    return yield* pump(total)
                }

                const nextTotal = total + chunk.byteLength
                if (nextTotal > maxBodyBytes) {
                    yield* connection.discard
                    yield* Queue.fail(
                        queue,
                        makeTransportError(request, `Godot HTTP response exceeded ${maxBodyBytes} bytes`),
                    )
                    return
                }
                yield* Queue.offer(queue, chunk)
                return yield* pump(nextTotal)
            })

        // Safety net for interruption; a no-op if a branch above already
        // released or discarded the connection (both are idempotent).
        return Effect.ensuring(pump(0), connection.discard)
    })

/**
 * Runs one request through a Godot `HTTPClient` connection: connecting (or
 * skipping straight to sending, when reusing a pooled connection), sending
 * the request, and polling for the response headers. `connect_to_host`,
 * `request`/`request_raw`, and the connecting/requesting poll loops are
 * ordinary `Effect`s, so fiber interruption during those phases works
 * without any manual signal plumbing; `Effect.onExit` discards the
 * connection if that setup fails or is interrupted. Once headers arrive, the
 * connection is either released immediately (no body) or handed to
 * `streamResponseBody`, which owns releasing or discarding it once the body
 * has been read.
 *
 * A connection checked out of the pool might have gone stale since it was
 * released (e.g. the server closed an idle keep-alive connection) — the only
 * way to find out is to try using it. If a *reused* connection's setup fails
 * before the response even starts, this discards it and retries once with a
 * brand-new connection; a fresh connection failing is a real error and isn't
 * retried again.
 */
const attemptGodotRequest = (
    options: GodotHttpClientOptions,
    request: HttpClientRequest.HttpClientRequest,
    url: {
        readonly protocol: string
        readonly hostname: string
        readonly pathname: string
        readonly search: string
    },
    signal: AbortableSignal,
    body: EncodedRequestBody,
    maxBodyBytes: number,
    port: number,
    tlsOptions: TLSOptions | undefined,
    client: GodotHTTPClient,
    reused: boolean,
    pool: GodotConnectionPool.GodotConnectionPoolShape | undefined,
    hostKey: string,
): Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError> =>
    Effect.gen(function* () {
        const connection = yield* makeConnection(client, signal, pool, hostKey)
        if (options.readChunkSize !== undefined) {
            connection.client.read_chunk_size = options.readChunkSize
        }

        return yield* Effect.onExit(
            Effect.gen(function* () {
                if (!reused) {
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

                    yield* pollUntilStatusIsNot(connection, request, GODOT_STATUS_AWAITING_CONNECTION)
                }

                const headers = toRequestHeaderLines(request, body)
                const method = GODOT_METHOD[request.method]
                const target = url.pathname + url.search
                const requestCode =
                    body.body === undefined || typeof body.body === "string"
                        ? connection.client.request(method, target, headers, body.body)
                        : connection.client.request_raw(method, target, headers, globalThis.Array.from(body.body))
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
                    new Set([GODOT_STATUS_REQUESTING]),
                )

                if (!connection.client.has_response()) {
                    return yield* Effect.fail(makeTransportError(request, "Godot HTTPClient request has no response"))
                }

                const status = connection.client.get_response_code()
                const responseHeaders = toLines(connection.client.get_response_headers())

                if (statusAfterRequest !== GODOT_STATUS_BODY) {
                    yield* connection.release
                    return new GodotClientResponse(request, status, responseHeaders, Stream.empty)
                }

                return new GodotClientResponse(
                    request,
                    status,
                    responseHeaders,
                    streamResponseBody(connection, request, maxBodyBytes),
                )
            }),
            (exit) => (Exit.isFailure(exit) ? connection.discard : Effect.void),
        )
    })

/**
 * Runs one request end to end. Pooling is opt-in and ambient: this only
 * pools when a `GodotConnectionPool` happens to be in scope — via
 * `Effect.serviceOption` rather than a parameter — which is exactly what
 * `layerWithOptions` arranges and `make` doesn't.
 */
const runGodotRequest = (
    options: GodotHttpClientOptions,
    maxBodyBytes: number,
    request: HttpClientRequest.HttpClientRequest,
    url: {
        readonly protocol: string
        readonly hostname: string
        readonly port: string
        readonly pathname: string
        readonly search: string
    },
    signal: AbortableSignal,
): Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError> =>
    Effect.gen(function* () {
        const body = yield* encodeRequestBody(request)
        const pool = Option.getOrUndefined(yield* Effect.serviceOption(GodotConnectionPool.GodotConnectionPool))

        const isHttps = url.protocol === "https:"
        const tlsOptions = isHttps
            ? ((options.createTlsOptions ?? (() => TLSOptions.client()))() ?? undefined)
            : undefined
        if (isHttps && tlsOptions === undefined) {
            return yield* Effect.fail(
                makeTransportError(request, "HTTPS requires a TLSOptions instance, but none was available"),
            )
        }

        const port = url.port !== "" ? Number(url.port) : isHttps ? 443 : 80
        const hostKey = `${isHttps ? "https" : "http"}://${url.hostname}:${port}`

        const attempt = (client: GodotHTTPClient, reused: boolean) =>
            attemptGodotRequest(
                options,
                request,
                url,
                signal,
                body,
                maxBodyBytes,
                port,
                tlsOptions,
                client,
                reused,
                pool,
                hostKey,
            )

        if (options.createClient !== undefined) {
            return yield* attempt(options.createClient(), false)
        }

        const pooled = pool === undefined ? undefined : yield* pool.checkout(hostKey)
        if (pooled === undefined) {
            return yield* attempt(new GodotHTTPClient(), false)
        }

        return yield* Effect.catch(attempt(pooled, true), () => attempt(new GodotHTTPClient(), false))
    })

/**
 * Constructs an Effect `HttpClient` backed by Godot `HTTPClient` connections.
 *
 * Unlike `layer`/`layerWithOptions`, this has no `GodotConnectionPool` in
 * scope, so `runGodotRequest` never finds one to check connections out of:
 * every request gets a fresh connection, closed at the end of that request —
 * the same no-surprises behavior as passing a custom `createClient`. Prefer
 * `layer`/`layerWithOptions` for real use, so connections actually get
 * reused; this is a lower-level building block for when you don't have a
 * `Scope` to own a pool with.
 */
export const make = (options: GodotHttpClientOptions = {}): HttpClient.HttpClient => {
    const maxBodyBytes = normalizeMaxBodyBytes(options.maxBodyBytes)
    return HttpClient.make((request, url, signal) => runGodotRequest(options, maxBodyBytes, request, url, signal))
}

/**
 * Provides the current Effect `HttpClient` service using Godot `HTTPClient`,
 * with the given options.
 *
 * Connections to the same host are pooled and reused across requests (per
 * Godot's own guidance for `HTTPClient`), unless `options.createClient` is
 * set. This requires a `GodotConnectionPool` in scope — provide one with
 * `GodotConnectionPool.layer` from `./GodotConnectionPool`, e.g.
 * `Layer.provide(GodotHttpClient.layer, GodotConnectionPool.layer)` — rather
 * than building one implicitly, so its `Scope` (and when it closes) is the
 * caller's choice. The resolved pool is pinned into every request's context
 * with `Effect.provideService`, so `runGodotRequest` finds it via
 * `Effect.serviceOption` regardless of what's ambient wherever the resulting
 * `HttpClient` actually gets called.
 */
export const layerWithOptions = (
    options: GodotHttpClientOptions,
): Layer.Layer<HttpClient.HttpClient, never, GodotConnectionPool.GodotConnectionPool> => {
    const maxBodyBytes = normalizeMaxBodyBytes(options.maxBodyBytes)

    const client = GodotConnectionPool.GodotConnectionPool.pipe(
        Effect.map((pool) =>
            HttpClient.make((request, url, signal) =>
                runGodotRequest(options, maxBodyBytes, request, url, signal).pipe(
                    Effect.provideService(GodotConnectionPool.GodotConnectionPool, pool),
                ),
            ),
        ),
    )

    return Layer.effect(HttpClient.HttpClient, client)
}

/** {@link layerWithOptions}, with every option left at its default. */
export const layer: Layer.Layer<HttpClient.HttpClient, never, GodotConnectionPool.GodotConnectionPool> = layerWithOptions({})
