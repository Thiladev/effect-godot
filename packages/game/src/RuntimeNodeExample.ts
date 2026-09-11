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
 * Owns the `ManagedRuntime` for `Greeter`. Attach this script to the scene's
 * root node — every `EffectfulNode` built from `GreeterRuntime` elsewhere in
 * the same tree finds it via `RuntimeNode`'s node group, regardless of where
 * either node sits in the hierarchy.
 */
export const GreeterRuntime = RuntimeNode.RuntimeNode(GreeterLive)

export default GreeterRuntime
