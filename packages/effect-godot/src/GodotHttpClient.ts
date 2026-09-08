import { Effect, Inspectable, Layer, Option, Pipeable, Stream } from "effect"
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
const GODOT_HTTP_REQUEST_SUCCESS = 0
const GODOT_HTTP_REQUEST_BODY_SIZE_LIMIT_EXCEEDED = 7

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

const toHeaderArray = (headers: Headers.Headers, contentType?: string) => {
    const result = Object.entries(headers).map(
        ([name, value]) => `${name}: ${value}`,
    )

    if (contentType !== undefined && headers["content-type"] === undefined) {
        result.push(`Content-Type: ${contentType}`)
    }

    return result
}

const toEffectHeaders = (headers: readonly string[]) => {
    const entries: Array<readonly [string, string]> = []

    for (const header of headers) {
        const separator = header.indexOf(":")
        if (separator < 0) continue

        entries.push([
            header.slice(0, separator).trim(),
            header.slice(separator + 1).trim(),
        ])
    }

    return Headers.fromInput(entries)
}

const toByteArray = (
    body: PackedByteArray | Uint8Array | ArrayBuffer,
): Uint8Array => {
    if (body instanceof Uint8Array) return new Uint8Array(body)
    if (body instanceof ArrayBuffer) return new Uint8Array(body.slice(0))

    return new Uint8Array(body.to_array_buffer().slice(0))
}

const toHeaderLines = (headers: PackedStringArray | readonly string[]) => {
    if (Array.isArray(headers)) return [...headers]

    const packedHeaders = headers as PackedStringArray
    const result: string[] = []
    for (let index = 0; index < packedHeaders.size(); index += 1) {
        result.push(packedHeaders.get(index))
    }
    return result
}

const decodeUtf8 = (bytes: Uint8Array): string => {
    let result = ""

    for (let index = 0; index < bytes.length; ) {
        const first = bytes[index++]
        if (first < 0x80) {
            result += String.fromCharCode(first)
            continue
        }

        const continuation = (count: number) => {
            if (index + count > bytes.length) return undefined
            let value = 0
            for (let offset = 0; offset < count; offset += 1) {
                const next = bytes[index++]
                if ((next & 0xc0) !== 0x80) return undefined
                value = (value << 6) | (next & 0x3f)
            }
            return value
        }

        if (first >= 0xc2 && first <= 0xdf) {
            const value = continuation(1)
            result += value === undefined ? "\ufffd" : String.fromCharCode(
                ((first & 0x1f) << 6) | value,
            )
            continue
        }

        if (first >= 0xe0 && first <= 0xef) {
            const value = continuation(2)
            if (value === undefined) {
                result += "\ufffd"
                continue
            }
            result += String.fromCharCode(((first & 0x0f) << 12) | value)
            continue
        }

        if (first >= 0xf0 && first <= 0xf4) {
            const value = continuation(3)
            if (value === undefined) {
                result += "\ufffd"
                continue
            }
            const codePoint = ((first & 0x07) << 18) | value
            result += String.fromCodePoint(codePoint)
            continue
        }

        result += "\ufffd"
    }

    return result
}

const toEffectCookies = (headers: readonly string[]) =>
    Cookies.fromSetCookie(
        headers
            .filter((header) => header.toLowerCase().startsWith("set-cookie:"))
            .map((header) => header.slice(header.indexOf(":") + 1).trim()),
    )

const decodeUrlParams = (value: string) => {
    const entries: Array<readonly [string, string]> = []

    if (value !== "") {
        for (const item of value.split("&")) {
            const separator = item.indexOf("=")
            const key = separator < 0 ? item : item.slice(0, separator)
            const rawValue = separator < 0 ? "" : item.slice(separator + 1)
            entries.push([
                decodeURIComponent(key.replaceAll("+", " ")),
                decodeURIComponent(rawValue.replaceAll("+", " ")),
            ])
        }
    }

    return UrlParams.fromInput(entries)
}

const makeDecodeError = (
    request: HttpClientRequest.HttpClientRequest,
    response: HttpClientResponse.HttpClientResponse,
    description: string,
    cause?: unknown,
) =>
    new HttpClientError.HttpClientError({
        reason: new HttpClientError.DecodeError({
            request,
            response,
            description,
            cause,
        }),
    })

const makeResponse = (
    request: HttpClientRequest.HttpClientRequest,
    status: number,
    rawHeaders: readonly string[],
    body: Uint8Array,
): HttpClientResponse.HttpClientResponse => {
    const headers = toEffectHeaders(rawHeaders)
    const responseBody = new Uint8Array(body)
    const text = Effect.succeed(decodeUtf8(responseBody))

    let response!: HttpClientResponse.HttpClientResponse
    response = {
        [HttpIncomingMessage.TypeId]: HttpIncomingMessage.TypeId,
        [HttpClientResponse.TypeId]: HttpClientResponse.TypeId,
        [Inspectable.NodeInspectSymbol]: () => ({
            _id: "HttpClientResponse",
            status,
        }),
        request,
        status,
        headers,
        cookies: toEffectCookies(rawHeaders),
        remoteAddress: Option.none(),
        stream: Stream.succeed(new Uint8Array(responseBody)),
        arrayBuffer: Effect.succeed(responseBody.slice().buffer as ArrayBuffer),
        text,
        json: Effect.flatMap(text, (value) =>
            Effect.try({
                try: () => (value === "" ? null : JSON.parse(value)),
                catch: (cause) =>
                    makeDecodeError(
                        request,
                        response,
                        "failed to decode JSON response",
                        cause,
                    ),
            }),
        ),
        urlParamsBody: Effect.flatMap(text, (value) =>
            Effect.try({
                try: () => decodeUrlParams(value),
                catch: (cause) =>
                    makeDecodeError(
                        request,
                        response,
                        "failed to decode URL-encoded response body",
                        cause,
                    ),
            }),
        ),
        formData: Effect.suspend(() =>
            Effect.fail(
                makeDecodeError(
                    request,
                    response,
                    "GodotHttpClient does not decode multipart form data",
                ),
            ),
        ),
        pipe<A>(this: A, ...fns: ReadonlyArray<(value: any) => any>): any {
            return Pipeable.pipeArguments(this, fns as unknown as IArguments)
        },
        toJSON: () => ({
            _id: "HttpClientResponse",
            status,
            request: request.toJSON(),
        }),
    }

    return response
}

type EncodedRequestBody = {
    readonly body?: string | Uint8Array
    readonly contentType?: string
}

const encodeRequestBody = (
    request: HttpClientRequest.HttpClientRequest,
): Effect.Effect<EncodedRequestBody, HttpClientError.HttpClientError> => {
    switch (request.body._tag) {
        case "Empty":
            return Effect.succeed({})
        case "Raw": {
            const body = request.body.body
            if (typeof body === "string") {
                return Effect.succeed({ body, contentType: request.body.contentType })
            }
            if (body instanceof Uint8Array) {
                return Effect.succeed({
                    body: new Uint8Array(body),
                    contentType: request.body.contentType,
                })
            }
            if (body instanceof ArrayBuffer) {
                return Effect.succeed({
                    body: new Uint8Array(body),
                    contentType: request.body.contentType,
                })
            }
            return Effect.fail(
                new HttpClientError.HttpClientError({
                    reason: new HttpClientError.EncodeError({
                        request,
                        description:
                            "GodotHttpClient only supports string and byte-array request bodies",
                    }),
                }),
            )
        }
        case "Uint8Array":
            return Effect.succeed({
                body: new Uint8Array(request.body.body),
                contentType: request.body.contentType,
            })
        case "FormData":
        case "Stream":
            return Effect.fail(
                new HttpClientError.HttpClientError({
                    reason: new HttpClientError.EncodeError({
                        request,
                        description:
                            "GodotHttpClient does not support streaming or multipart request bodies yet",
                    }),
                }),
            )
    }
}

const makeTransportError = (
    request: HttpClientRequest.HttpClientRequest,
    description: string,
    cause?: unknown,
) =>
    new HttpClientError.HttpClientError({
        reason: new HttpClientError.TransportError({
            request,
            description,
            cause,
        }),
    })

const executeGodotRequest = (
    options: GodotHttpClientOptions,
    request: HttpClientRequest.HttpClientRequest,
    url: { readonly toString: () => string },
    signal: {
        readonly addEventListener: (
            type: "abort",
            listener: () => void,
            options?: { readonly once?: boolean },
        ) => void
        readonly removeEventListener: (
            type: "abort",
            listener: () => void,
        ) => void
    },
    body: EncodedRequestBody,
    maxBodyBytes: number,
): Effect.Effect<
    HttpClientResponse.HttpClientResponse,
    HttpClientError.HttpClientError
> =>
    Effect.callback((resume) => {
        let active = true
        let started = false
        let connected = false
        let godotRequest: HTTPRequest | undefined
        let callable: Callable<GodotHttpRequestCompleted> | undefined

        const dispose = () => {
            if (connected && godotRequest !== undefined && callable !== undefined) {
                try {
                    godotRequest.request_completed.disconnect(callable)
                } catch {
                    // The node may already have been freed by Godot.
                }
                connected = false
            }

            if (started && godotRequest !== undefined) {
                try {
                    godotRequest.cancel_request()
                } catch {
                    // Cancellation is best effort during interruption.
                }
                started = false
            }

            if (godotRequest !== undefined) {
                try {
                    godotRequest.queue_free()
                } catch {
                    // Queueing an already-freed node is best effort.
                }
            }
        }

        const fail = (error: HttpClientError.HttpClientError) => {
            if (!active) return
            active = false
            dispose()
            resume(Effect.fail(error))
        }

        const onAbort = () => {
            fail(makeTransportError(request, "Godot HTTP request aborted"))
        }

        signal.addEventListener("abort", onAbort, { once: true })

        try {
            godotRequest = options.createRequest()
            options.parent.add_child(godotRequest)
            godotRequest.body_size_limit = maxBodyBytes
            if (options.timeoutSeconds !== undefined) {
                godotRequest.timeout = options.timeoutSeconds
            }
            if (options.maxRedirects !== undefined) {
                godotRequest.max_redirects = options.maxRedirects
            }
            if (options.acceptGzip !== undefined) {
                godotRequest.accept_gzip = options.acceptGzip
            }

            const listener: GodotHttpRequestCompleted = (
                result,
                status,
                rawHeaders,
                rawBody,
            ) => {
                if (!active) return

                started = false
                const responseBody = toByteArray(rawBody)
                const headers = toHeaderLines(rawHeaders)
                if (
                    result === GODOT_HTTP_REQUEST_BODY_SIZE_LIMIT_EXCEEDED ||
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

                if (result !== GODOT_HTTP_REQUEST_SUCCESS) {
                    fail(
                        makeTransportError(
                            request,
                            `Godot HTTPRequest failed with result ${result}`,
                            { result, status, headers },
                        ),
                    )
                    return
                }

                active = false
                dispose()
                resume(
                    Effect.succeed(
                        makeResponse(request, status, headers, responseBody),
                    ),
                )
            }

            callable = options.createCallable(listener)
            godotRequest.request_completed.connect(callable)
            connected = true

            const headers = toHeaderArray(request.headers, body.contentType)
            const method = GODOT_METHOD[request.method]
            started = true
            const code =
                body.body === undefined || typeof body.body === "string"
                    ? godotRequest.request(
                          url.toString(),
                          headers,
                          method,
                          body.body,
                      )
                    : godotRequest.request_raw(
                          url.toString(),
                          headers,
                          method,
                          Array.from(body.body),
                      )

            if (active && code !== GODOT_OK) {
                fail(
                    makeTransportError(
                        request,
                        `Godot HTTPRequest could not start (error ${code})`,
                        { code },
                    ),
                )
            }
        } catch (cause) {
            fail(makeTransportError(request, "Godot HTTPRequest setup failed", cause))
        }

        return Effect.sync(() => {
            signal.removeEventListener("abort", onAbort)
            if (!active) return
            active = false
            dispose()
        })
    })

/** Constructs an Effect `HttpClient` backed by Godot `HTTPRequest` nodes. */
export const make = (
    options: GodotHttpClientOptions,
): HttpClient.HttpClient => {
    const maxBodyBytes = normalizeMaxBodyBytes(options.maxBodyBytes)

    return HttpClient.make((request, url, signal) =>
        Effect.flatMap(encodeRequestBody(request), (body) =>
            executeGodotRequest(options, request, url, signal, body, maxBodyBytes),
        ),
    )
}

/** Provides the current Effect `HttpClient` service using Godot HTTPRequest. */
export const layer = (options: GodotHttpClientOptions) =>
    Layer.effect(HttpClient.HttpClient, Effect.sync(() => make(options)))
