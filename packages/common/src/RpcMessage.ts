// The wire protocol RpcClient.ts and RpcServer.ts both speak, and the
// transport contract either side plugs into it.
//
// godot-cef only gives two one-way string channels: the UI pushes a string to
// the game (`window.sendIpcMessage` / the `ipc_message` signal) and the game
// pushes a string to the UI (`CefTexture.eval` running JS in the page). There
// is no real request/response transport underneath. RpcClient/RpcServer
// emulate one on top of those two channels: every UI -> game request carries
// an `id`, the matching game -> UI reply is correlated by that same `id`, and
// anything the game pushes without a request (a broadcast) is delivered as
// an event instead. Hence "pseudo": the RPC semantics are real, the
// transport is not.

import { Schema } from "effect"

// Both Godot's JS engine and the browser provide `console`; this package's
// tsconfig otherwise stays deliberately free of DOM/Node lib globals.
declare const console: {
    readonly log: (...args: ReadonlyArray<unknown>) => void
}

// The only thing either runtime has to supply — a way to send a string out
// and a way to be notified when one arrives.
export interface Transport {
    readonly send: (message: string) => void
    readonly onMessage: (listener: (message: string) => void) => () => void
}

// The schemas plugged into RpcClient/RpcServer never need decoding/encoding
// services (they're plain JSON-shaped data), which is what lets a single
// schema value be used for both `decodeUnknownSync` and `encodeSync`.
export type AnySchema = Schema.Codec<unknown, unknown, never, never>

export const RequestEnvelope = Schema.TaggedStruct("RpcRequest", {
    id: Schema.String,
    request: Schema.Unknown,
})

export const ResponseEnvelope = Schema.TaggedUnion({
    RpcSuccess: { id: Schema.String, value: Schema.Unknown },
    RpcFailure: { id: Schema.String, error: Schema.Unknown },
})
export type ResponseEnvelope = typeof ResponseEnvelope.Type

export const EventEnvelope = Schema.TaggedStruct("RpcEvent", {
    event: Schema.Unknown,
})

export const GameToUiEnvelope = Schema.Union([ResponseEnvelope, EventEnvelope])

export function nextId(): string {
    return Math.random().toString(36).slice(2)
}

export function decodeQuietly<S extends AnySchema>(
    schema: S,
    input: unknown,
    what: string,
): S["Type"] | undefined {
    try {
        return Schema.decodeUnknownSync(schema)(input)
    } catch (cause) {
        console.log(`[rpc] ignoring malformed ${what}`, cause)
        return undefined
    }
}

export function parseQuietly(raw: string): unknown {
    try {
        return JSON.parse(raw)
    } catch (cause) {
        console.log("[rpc] ignoring malformed message", raw, cause)
        return undefined
    }
}

// A tagged union of requests, as produced by `Schema.TaggedUnion`. Every
// procedure a group exposes is one member of this union.
export type AnyRequestUnion = AnySchema & {
    readonly Type: { readonly _tag: string }
    readonly match: (
        value: any,
        cases: Record<string, (value: any) => unknown>,
    ) => unknown
}

export type Tag<Req extends AnyRequestUnion> = Req["Type"]["_tag"]
export type RequestOf<
    Req extends AnyRequestUnion,
    T extends Tag<Req>,
> = Extract<Req["Type"], { readonly _tag: T }>
export type SchemaByTag<Req extends AnyRequestUnion> = {
    readonly [T in Tag<Req>]: AnySchema
}
