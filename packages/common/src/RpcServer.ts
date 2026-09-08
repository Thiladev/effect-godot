// The game side of the pseudo-RPC engine: handle the UI's procedure calls
// and push events to it. See RpcMessage.ts for the wire protocol.

import { Effect, Exit, Option, Schema, Scope } from "effect"
import * as RpcMessage from "./RpcMessage"

// Both Godot's JS engine and the browser provide `console`; this package's
// tsconfig otherwise stays deliberately free of DOM/Node lib globals.
declare const console: {
    readonly log: (...args: ReadonlyArray<unknown>) => void
}

export interface Server<Ev extends RpcMessage.AnySchema> {
    readonly emit: (event: Ev["Type"]) => Effect.Effect<void>
}

// Scoped: holds a live transport subscription for as long as the returned
// Server is in use, and tears it down when the scope closes.
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
    readonly handlers: {
        readonly [T in RpcMessage.Tag<Req>]: (
            request: RpcMessage.RequestOf<Req, T>,
        ) => Effect.Effect<Success[T]["Type"], Err[T]["Type"]>
    }
}): Effect.Effect<Server<Ev>, never, Scope.Scope> {
    return Effect.gen(function* () {
        const unsubscribe = options.transport.onMessage((raw) => {
            const parsed = RpcMessage.parseQuietly(raw)
            if (parsed === undefined) return
            const envelope = RpcMessage.decodeQuietly(
                RpcMessage.RequestEnvelope,
                parsed,
                "ui -> game message",
            )
            if (!envelope) return
            const request = RpcMessage.decodeQuietly(
                options.request,
                envelope.request,
                "request",
            )
            if (!request) return

            const tag = (request as { _tag: string })
                ._tag as RpcMessage.Tag<Req>
            const effect = options.request.match(
                request,
                options.handlers as Record<
                    string,
                    (value: unknown) => Effect.Effect<unknown, unknown>
                >,
            ) as Effect.Effect<unknown, unknown>

            Effect.runPromiseExit(effect).then((exit) => {
                if (Exit.isSuccess(exit)) {
                    const value = Schema.encodeSync(options.success[tag])(
                        exit.value,
                    )
                    options.transport.send(
                        JSON.stringify({
                            _tag: "RpcSuccess",
                            id: envelope.id,
                            value,
                        }),
                    )
                    return
                }

                // A defect here is a genuine bug (the handler threw instead of
                // failing with its declared error type) — there's no schema to
                // encode it as, so it's logged loudly and the call is left pending
                // rather than pretending it succeeded.
                const failure = Exit.findErrorOption(exit)
                if (Option.isNone(failure)) {
                    console.log(
                        `[rpc] unhandled defect in "${tag}" handler`,
                        exit.cause,
                    )
                    return
                }
                const error = Schema.encodeSync(options.error[tag])(
                    failure.value,
                )
                options.transport.send(
                    JSON.stringify({
                        _tag: "RpcFailure",
                        id: envelope.id,
                        error,
                    }),
                )
            })
        })
        yield* Effect.addFinalizer(() => Effect.sync(unsubscribe))

        function emit(event: Ev["Type"]): Effect.Effect<void> {
            return Effect.sync(() => {
                const encoded = Schema.encodeSync(options.event)(event)
                options.transport.send(
                    JSON.stringify({ _tag: "RpcEvent", event: encoded }),
                )
            })
        }

        return { emit }
    })
}
