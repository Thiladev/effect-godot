import { Layer } from "effect"
import { GodotConnectionPool, GodotHttpClient, RuntimeNode } from "effect-godot"


export const layer = Layer.empty.pipe(
    Layer.provideMerge(GodotHttpClient.layer),
    Layer.provideMerge(GodotConnectionPool.layer),
)

export default class Runtime extends RuntimeNode.RuntimeNode(layer) {
    // Called when the node enters the scene tree for the first time.
    _ready(): void {

    }

    // Called every frame. 'delta' is the elapsed time since the previous frame.
    _process(delta: number): void {
    }
}
