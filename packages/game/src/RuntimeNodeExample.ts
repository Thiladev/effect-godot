import { Context, Effect, Layer } from "effect"
import { RuntimeNode } from "effect-godot"


/** A toy Effect service, just to give the example runtime something to provide. */
export class Greeter extends Context.Service<
    Greeter,
    { readonly greet: (name: string) => Effect.Effect<string> }
>()("example/Greeter") {}

const GreeterLive = Layer.succeed(Greeter, {
    greet: name => Effect.succeed(`Hello, ${name}!`),
})

/**
 * Owns the `ManagedRuntime` for `Greeter`. Register this script as an
 * autoload — autoloads `_ready` before the main scene, so by the time any
 * `EffectfulNode` built from `GreeterRuntime` runs its own `_ready`, this
 * node has already registered itself in `RuntimeNode`'s node group.
 */
export default class GreeterRuntime extends RuntimeNode.RuntimeNode(GreeterLive) {}
