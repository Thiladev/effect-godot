import { Effect, Inspectable, Layer, Option, type Pipeable, type Schema, Stream } from "effect"
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
import type {
    Callable,
    HTTPClient as GodotHTTPClient,
    HTTPRequest,
    Node,
    PackedByteArray,
    PackedStringArray,
} from "godot"

/** The default maximum decompressed response body size. */
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024

/** The callback shape emitted by `HTTPRequest.request_completed`. */
export type GodotHttpRequestCompleted = (
    result: number,
    status: number,
    headers: PackedStringArray,
    body: PackedByteArray,
) => void

/**
 * Dependencies needed to construct the Effect `HttpClient` layer.
 *
 * Factories are explicit so this module remains safe to import in Bun/Node
 * tests, where the runtime-only `godot` module is not available.
 */
export interface GodotHttpClientOptions {
    readonly parent: Pick<Node, "add_child">
    readonly createRequest: () => HTTPRequest
    readonly createCallable: (
        listener: GodotHttpRequestCompleted,
    ) => Callable<GodotHttpRequestCompleted>
    readonly maxBodyBytes?: number
    readonly timeoutSeconds?: number
    readonly maxRedirects?: number
    readonly acceptGzip?: boolean
}

const GODOT_OK = 0
const GODOT_RESULT_SUCCESS = 0
const GODOT_RESULT_BODY_SIZE_LIMIT_EXCEEDED = 7

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
        case "FormData":
        case "Stream":
            return unsupported(
                "GodotHttpClient does not support streaming or multipart request bodies",
            )
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
 * The Godot `HTTPRequest` node buffers the whole response before emitting
 * `request_completed`, so bodies arrive as a single `Uint8Array` rather than
 * an incremental stream. There is no `TextDecoder`/`URLSearchParams` in the
 * QuickJS engine GodotJS embeds, so UTF-8 and `x-www-form-urlencoded`
 * decoding are implemented by hand below.
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

class GodotClientResponse extends Inspectable.Class
    implements HttpClientResponse.HttpClientResponse, Pipeable.Pipeable {
    readonly [HttpIncomingMessage.TypeId]: typeof HttpIncomingMessage.TypeId =
        HttpIncomingMessage.TypeId
    readonly [HttpClientResponse.TypeId]: typeof HttpClientResponse.TypeId =
        HttpClientResponse.TypeId

    readonly request: HttpClientRequest.HttpClientRequest
    readonly status: number
    private readonly rawHeaders: readonly string[]
    private readonly body: Uint8Array

    constructor(
        request: HttpClientRequest.HttpClientRequest,
        status: number,
        rawHeaders: readonly string[],
        body: Uint8Array,
    ) {
        super()
        this.request = request
        this.status = status
        this.rawHeaders = rawHeaders
        this.body = body
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

    get stream(): Stream.Stream<Uint8Array, HttpClientError.HttpClientError> {
        return Stream.succeed(this.body)
    }

    get arrayBuffer(): Effect.Effect<ArrayBuffer, HttpClientError.HttpClientError> {
        return Effect.succeed(this.body.buffer as ArrayBuffer)
    }

    private cachedText?: Effect.Effect<string, HttpClientError.HttpClientError>
    get text(): Effect.Effect<string, HttpClientError.HttpClientError> {
        return (this.cachedText ??= Effect.sync(() => decodeUtf8(this.body)))
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

/**
 * Runs one request through a Godot `HTTPRequest` node.
 *
 * Follows the lifecycle from `EFFECT_PLATFORM_GODOT_FEASIBILITY.md`: the node
 * is attached on the main thread, `request_completed` resumes the Effect
 * callback exactly once, and every exit path (success, failure, or fiber
 * interruption through `signal`) disconnects the signal, cancels any request
 * still in flight, and frees the node.
 */
interface AbortableSignal {
    readonly addEventListener: (
        type: "abort",
        listener: () => void,
        options?: { readonly once?: boolean },
    ) => void
    readonly removeEventListener: (type: "abort", listener: () => void) => void
}

const runGodotRequest = (
    options: GodotHttpClientOptions,
    request: HttpClientRequest.HttpClientRequest,
    url: { readonly toString: () => string },
    signal: AbortableSignal,
    body: EncodedRequestBody,
    maxBodyBytes: number,
): Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError> =>
    Effect.callback((resume) => {
        const godotRequest = options.createRequest()
        let settled = false
        let inFlight = false
        let connected = false

        const cleanup = () => {
            if (connected) {
                godotRequest.request_completed.disconnect(callable)
                connected = false
            }
            if (inFlight) {
                godotRequest.cancel_request()
                inFlight = false
            }
            godotRequest.queue_free()
        }

        const fail = (error: HttpClientError.HttpClientError) => {
            if (settled) return
            settled = true
            cleanup()
            resume(Effect.fail(error))
        }

        const onAbort = () => fail(makeTransportError(request, "Godot HTTP request aborted"))
        signal.addEventListener("abort", onAbort, { once: true })

        const callable = options.createCallable((result, status, rawHeaders, rawBody) => {
            if (settled) return
            inFlight = false

            const responseBody = toBytes(rawBody)
            const headerLines = toLines(rawHeaders)

            if (
                result === GODOT_RESULT_BODY_SIZE_LIMIT_EXCEEDED ||
                responseBody.byteLength > maxBodyBytes
            ) {
                fail(
                    makeTransportError(
                        request,
                        `Godot HTTP response exceeded ${maxBodyBytes} bytes`,
                        { result, status },
                    ),
                )
                return
            }

            if (result !== GODOT_RESULT_SUCCESS) {
                fail(
                    makeTransportError(
                        request,
                        `Godot HTTPRequest failed with result ${result}`,
                        { result, status, headers: headerLines },
                    ),
                )
                return
            }

            settled = true
            cleanup()
            resume(
                Effect.succeed(
                    new GodotClientResponse(request, status, headerLines, responseBody),
                ),
            )
        })

        options.parent.add_child(godotRequest)
        godotRequest.body_size_limit = maxBodyBytes
        if (options.timeoutSeconds !== undefined) godotRequest.timeout = options.timeoutSeconds
        if (options.maxRedirects !== undefined) godotRequest.max_redirects = options.maxRedirects
        if (options.acceptGzip !== undefined) godotRequest.accept_gzip = options.acceptGzip

        godotRequest.request_completed.connect(callable)
        connected = true

        const headers = toRequestHeaderLines(request, body)
        const method = GODOT_METHOD[request.method]
        inFlight = true
        const code =
            body.body === undefined || typeof body.body === "string"
                ? godotRequest.request(url.toString(), headers, method, body.body)
                : godotRequest.request_raw(
                      url.toString(),
                      headers,
                      method,
                      Array.from(body.body),
                  )

        if (code !== GODOT_OK) {
            fail(makeTransportError(request, `Godot HTTPRequest could not start (error ${code})`, { code }))
        }

        return Effect.sync(() => {
            signal.removeEventListener("abort", onAbort)
            if (settled) return
            settled = true
            cleanup()
        })
    })

/** Constructs an Effect `HttpClient` backed by Godot `HTTPRequest` nodes. */
export const make = (options: GodotHttpClientOptions): HttpClient.HttpClient => {
    const maxBodyBytes = normalizeMaxBodyBytes(options.maxBodyBytes)

    return HttpClient.make((request, url, signal) =>
        Effect.flatMap(encodeRequestBody(request), (body) =>
            runGodotRequest(options, request, url, signal, body, maxBodyBytes),
        ),
    )
}

/** Provides the current Effect `HttpClient` service using Godot `HTTPRequest`. */
export const layer = (options: GodotHttpClientOptions): Layer.Layer<HttpClient.HttpClient> =>
    Layer.effect(HttpClient.HttpClient, Effect.sync(() => make(options)))

/** Alias for `layer`, matching this package's `<Thing>Layer` naming convention. */
export const GodotHttpClientLayer = layer
