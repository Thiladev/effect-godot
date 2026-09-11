import { Effect, Fiber, ManagedRuntime, type Layer } from "effect"
import { Node } from "godot"
import * as GodotCrypto from "./GodotCrypto.js"


type NodeClass = typeof Node

export interface RuntimeNodeClass<R, E> extends NodeClass {
    new (_: never): RuntimeNode<R, E>

    readonly group: string
    readonly EffectfulNode: <T extends NodeClass>(class_: T) => T & EffectfulNodeClass<R, E>
}

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

    static readonly EffectfulNode = <T extends NodeClass>(
        class_: T
    ): T & EffectfulNodeClass<R, E> => class extends class_ {
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
    }

    readonly runtime = ManagedRuntime.make(layer)

    async _ready(): Promise<void> {
        this.add_to_group(X.group)
        await this.runtime.context()
    }

    async _exit_tree(): Promise<void> {
        await this.runtime.dispose()
    }
}


export interface EffectfulNodeClass<R, E> {
    new (_: never): EffectfulNode<R, E>
}

export interface EffectfulNode<R, E> {
    readonly runtimeNode: RuntimeNode<R, E>

    readonly runSync: <A, E2>(effect: Effect.Effect<A, E2, R>) => A
    readonly runPromise: <A, E2>(effect: Effect.Effect<A, E2, R>, options?: Effect.RunOptions | undefined) => Promise<A>
    readonly runFork: <A, E2>(effect: Effect.Effect<A, E2, R>, options?: Effect.RunOptions | undefined) => Fiber.Fiber<A, E2 | E>
}
