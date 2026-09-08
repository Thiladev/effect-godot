import { Effect, Scope } from "effect"

/** A listener accepted by a GodotJS signal-like value. */
export type SignalListener<Args extends readonly unknown[]> = (
    ...args: Args
) => void

/**
 * The small structural part of a Godot signal needed by this adapter.
 *
 * Keeping this structural means the package does not need to import GodotJS's
 * runtime-only `godot` module just to expose a signal helper.
 */
export interface GodotSignal<Args extends readonly unknown[] = readonly unknown[]> {
    readonly connect: (listener: SignalListener<Args>) => void
    readonly disconnect: (listener: SignalListener<Args>) => void
}

/**
 * Subscribes to a signal for the surrounding Effect scope.
 *
 * The listener is disconnected exactly once when the scope closes. The
 * returned Effect should normally be used with `Effect.scoped` or forked with
 * `Effect.forkScoped`.
 */
export const subscribe = <Args extends readonly unknown[]>(
    signal: GodotSignal<Args>,
    listener: SignalListener<Args>,
): Effect.Effect<void, never, Scope.Scope> =>
    Effect.acquireRelease(
        Effect.sync(() => {
            signal.connect(listener)
        }),
        () => Effect.sync(() => signal.disconnect(listener)),
    )

/**
 * Waits for one signal emission and disconnects immediately after receiving it.
 *
 * Interruption also disconnects the listener through `Effect.callback`'s
 * cancellation finalizer.
 */
export const once = <Args extends readonly unknown[]>(
    signal: GodotSignal<Args>,
): Effect.Effect<Args> =>
    Effect.callback((resume) => {
        let active = true

        const listener: SignalListener<Args> = (...args) => {
            if (!active) return
            active = false
            signal.disconnect(listener)
            resume(Effect.succeed(args))
        }

        signal.connect(listener)

        return Effect.sync(() => {
            if (!active) return
            active = false
            signal.disconnect(listener)
        })
    })
