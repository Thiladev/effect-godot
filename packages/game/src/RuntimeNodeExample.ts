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
 * Owns the `ManagedRuntime` for `Greeter`. Attach this script to any node in
 * the scene — `EffectfulNode` descendants built from `GreeterRuntime` find
 * it regardless of where either node sits in the tree.
 */
export default class GreeterRuntime extends RuntimeNode.RuntimeNode(GreeterLive) {}
