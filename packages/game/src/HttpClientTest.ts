import { Console, Effect, Inspectable, Layer } from "effect"
import { GodotConnectionPool, GodotHttpClient } from "effect-godot"
import { HttpClient } from "effect/unstable/http"
import { Control, float64 } from "godot"


export default class HttpClientTest extends Control {
    // Called when the node enters the scene tree for the first time.
    async _ready(): Promise<void> {
        console.log("Querying...")
        await HttpClient.get("https://jsonplaceholder.typicode.com/posts/1").pipe(
            Effect.flatMap(res => res.json),
            Effect.flatMap(v => Console.log(Inspectable.toStringUnknown(v))),
            Effect.provide(Layer.provide(GodotHttpClient.layer, GodotConnectionPool.layer)),
            Effect.runPromise,
        )
    }

    _process(delta: float64): void {

    }
}
