import { Effect, Fiber, Layer, ManagedRuntime } from "effect"
import { Control, Node } from "godot"
import * as GodotCrypto from "./GodotCrypto.js"


type NodeClass = typeof Node

export type RuntimeNodeClass<R, E> = {
    new (_: never): RuntimeNode<R, E>

    readonly group: string
    readonly EffectfulNode: <T extends new (...args: any[]) => Node>(
        class_: T
    ) => EffectfulNodeClass<T, R, E>
} & Omit<NodeClass, "prototype">

/** The shape `RunEffect` looks for once it's found a candidate node by group. */
export interface RuntimeNode<R, E> extends Node {
    readonly runtime: ManagedRuntime.ManagedRuntime<R, E>
}

/**
 * A Godot `Node` mixin that owns a `ManagedRuntime` built from `layer`. Each
 * call to `RuntimeNode(layer)` gets its own unique, internal group name (a
 * UUIDv4) — not something you pick or pass in — so `EffectfulNode`-derived
 * nodes always find *this exact* instance via
 * `SceneTree.get_first_node_in_group` regardless of where either node sits
 * in the tree, and two separate `RuntimeNode(layer)` calls can never collide
 * on a name. The runtime is built (awaited) before `_ready` resolves, and
 * disposed on `_exit_tree`.
 */
export const RuntimeNode = <R, E>(
    layer: Layer.Layer<R, E, never>,
): RuntimeNodeClass<R, E> => class X extends Node {
    static readonly group = `effect-godot/RuntimeNode#${Effect.runSync(GodotCrypto.crypto.randomUUIDv4)}`

    static readonly EffectfulNode = <T extends new (...args: any[]) => Node>(
        class_: T
    ) => (class extends class_ {
        runtimeNode!: RuntimeNode<R, E>

        readonly runSync: <A, E2>(effect: Effect.Effect<A, E2, R>) => A
        readonly runPromise: <A, E2>(effect: Effect.Effect<A, E2, R>, options?: Effect.RunOptions | undefined) => Promise<A>
        readonly runFork: <A, E2>(effect: Effect.Effect<A, E2, R>, options?: Effect.RunOptions | undefined) => Fiber.Fiber<A, E2 | E>

        constructor(...args: any[]) {
            super(...args)

            this.runSync = effect => this.runtimeNode.runtime.runSync(effect)
            this.runPromise = (effect, options) => this.runtimeNode.runtime.runPromise(effect, options)
            this.runFork = (effect, options) => this.runtimeNode.runtime.runFork(effect, options)
        }

        _ready(): void {
            const found = this.get_tree().get_first_node_in_group(X.group) as RuntimeNode<R, E> | null
            if (!found)
                throw new Error(`EffectfulNode: no RuntimeNode found in group "${X.group}"`)
            this.runtimeNode = found
        }
    } as unknown as EffectfulNodeClass<T, R, E>)

    readonly runtime = ManagedRuntime.make(layer)

    async _enter_tree(): Promise<void> {
        this.add_to_group(X.group)
        await this.runtime.context()
    }

    async _exit_tree(): Promise<void> {
        await this.runtime.dispose()
    }
}


export type EffectfulNodeClass<T extends new (...args: any[]) => Node, R, E> = {
    new (...args: ConstructorParameters<T>): InstanceType<T> & EffectfulNode<R, E>
} & Omit<T, "prototype">

export interface EffectfulNode<R, E> {
    readonly runtimeNode: RuntimeNode<R, E>

    readonly runSync: <A, E2>(effect: Effect.Effect<A, E2, R>) => A
    readonly runPromise: <A, E2>(effect: Effect.Effect<A, E2, R>, options?: Effect.RunOptions | undefined) => Promise<A>
    readonly runFork: <A, E2>(effect: Effect.Effect<A, E2, R>, options?: Effect.RunOptions | undefined) => Fiber.Fiber<A, E2 | E>
}


const MyRuntime = RuntimeNode(GodotCrypto.layer)
class MyNode extends MyRuntime.EffectfulNode(Control) {
    _ready(): void {
        super._ready()
        this.runSync(Effect.log("issou"))
    }
}
