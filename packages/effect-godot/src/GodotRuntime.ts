import { Context, Effect, Fiber, Layer } from "effect"

/**
 * The lifetime owner for Effects started by a Godot node or autoload.
 *
 * The layer that provides this service owns the scope used by `runFork`.
 * Closing that layer interrupts every child fiber, which gives a Godot
 * lifecycle hook one place to tear down background work.
 */
export interface GodotRuntimeShape {
    readonly runFork: <A, E, R>(
        effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<Fiber.Fiber<A, E>, never, R>
}

/**
 * Effect service for work owned by a Godot lifecycle.
 *
 * This first slice deliberately does not import GodotJS globals. A Godot
 * autoload can provide `GodotRuntimeLayer` and call `runFork` from its
 * `_ready`/`_exit_tree` lifecycle without making the package unsafe to import
 * in Node or Bun tests.
 */
export class GodotRuntime extends Context.Service<
    GodotRuntime,
    GodotRuntimeShape
>()("effect-godot/GodotRuntime") {}

/**
 * Provides a runtime whose child fibers are interrupted with the layer scope.
 */
export const GodotRuntimeLayer = Layer.effect(
    GodotRuntime,
    Effect.gen(function* () {
        const scope = yield* Effect.scope

        return {
            runFork: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
                Effect.forkIn(effect, scope),
        }
    }),
)

/**
 * Forks work into the current Godot runtime lifetime.
 */
export const runFork = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    GodotRuntime.use((runtime) => runtime.runFork(effect))
