// The UI side of the pseudo-RPC engine: call the game's procedures and
// subscribe to its events. See RpcMessage.ts for the wire protocol.

import { Effect, PubSub, Schema, Scope, Stream } from "effect"
import * as RpcMessage from "./RpcMessage"

export interface Client<
    Req extends RpcMessage.AnyRequestUnion,
    Success extends RpcMessage.SchemaByTag<Req>,
    Err extends RpcMessage.SchemaByTag<Req>,
    Ev extends RpcMessage.AnySchema,
> {
    readonly call: <T extends RpcMessage.Tag<Req>>(
        request: RpcMessage.RequestOf<Req, T>,
    ) => Effect.Effect<Success[T]["Type"], Err[T]["Type"]>
    readonly events: Stream.Stream<Ev["Type"]>
}

// Scoped: holds a live transport subscription and an event PubSub for as
// long as the returned Client is in use, and tears both down when the scope
// closes.
export function make<
    Req extends RpcMessage.AnyRequestUnion,
    Success extends RpcMessage.SchemaByTag<Req>,
    Err extends RpcMessage.SchemaByTag<Req>,
    Ev extends RpcMessage.AnySchema,
>(options: {
    readonly transport: RpcMessage.Transport
    readonly request: Req
    readonly success: Success
    readonly error: Err
    readonly event: Ev
}): Effect.Effect<Client<Req, Success, Err, Ev>, never, Scope.Scope> {
    return Effect.gen(function* () {
        const pending = new Map<
            string,
            (envelope: RpcMessage.ResponseEnvelope) => void
        >()
        const pubsub = yield* PubSub.unbounded<Ev["Type"]>()
        yield* Effect.addFinalizer(() => PubSub.shutdown(pubsub))

        const unsubscribe = options.transport.onMessage((raw) => {
            const parsed = RpcMessage.parseQuietly(raw)
            if (parsed === undefined) return
            const envelope = RpcMessage.decodeQuietly(
                RpcMessage.GameToUiEnvelope,
                parsed,
                "game -> ui message",
            )
            if (!envelope) return

            if (envelope._tag === "RpcEvent") {
                const event = RpcMessage.decodeQuietly(
                    options.event,
                    envelope.event,
                    "event",
                )
                if (event === undefined) return
                PubSub.publishUnsafe(pubsub, event)
                return
            }

            const resolve = pending.get(envelope.id)
            if (!resolve) return
            pending.delete(envelope.id)
            resolve(envelope)
        })
        yield* Effect.addFinalizer(() => Effect.sync(unsubscribe))

        function call<T extends RpcMessage.Tag<Req>>(
            request: RpcMessage.RequestOf<Req, T>,
        ): Effect.Effect<Success[T]["Type"], Err[T]["Type"]> {
            return Effect.callback<unknown, unknown>((resume) => {
                const tag = (request as { _tag: string })
                    ._tag as RpcMessage.Tag<Req>
                const id = RpcMessage.nextId()
                pending.set(id, (envelope) => {
                    if (envelope._tag === "RpcSuccess") {
                        const value = RpcMessage.decodeQuietly(
                            options.success[tag],
                            envelope.value,
                            `${tag} result`,
                        )
                        resume(
                            value === undefined
                                ? Effect.die(
                                      `[rpc] malformed result for "${tag}"`,
                                  )
                                : Effect.succeed(value),
                        )
                    } else {
                        const error = RpcMessage.decodeQuietly(
                            options.error[tag],
                            envelope.error,
                            `${tag} error`,
                        )
                        resume(
                            error === undefined
                                ? Effect.die(
                                      `[rpc] malformed error for "${tag}"`,
                                  )
                                : Effect.fail(error),
                        )
                    }
                })
                const encoded = Schema.encodeSync(options.request)(request)
                options.transport.send(
                    JSON.stringify({
                        _tag: "RpcRequest",
                        id,
                        request: encoded,
                    }),
                )
            }) as Effect.Effect<Success[T]["Type"], Err[T]["Type"]>
        }

        return { call, events: Stream.fromPubSub(pubsub) }
    })
}
