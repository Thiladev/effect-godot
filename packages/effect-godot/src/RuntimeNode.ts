import { ManagedRuntime, type Layer } from "effect"
import { Node } from "godot"


export const RuntimeNode = <ROut, E>(
    layer: Layer.Layer<ROut, E, never>
) => class extends Node {
    readonly runtime = ManagedRuntime.make(layer)

    async _ready(): Promise<void> {
        await this.runtime.context()
    }

    async _exit_tree(): Promise<void> {
        await this.runtime.dispose()
    }
}
