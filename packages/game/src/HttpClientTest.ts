import { Console, Effect } from "effect"
import { GodotHttpClient } from "effect-godot"
import { HttpClient } from "effect/unstable/http"
import { Control } from "godot"


export default class HttpClientTest extends Control {
    // Called when the node enters the scene tree for the first time.
    async _ready(): Promise<void> {
        console.log("Querying...")
        await HttpClient.get("https://jsonplaceholder.typicode.com/posts/1").pipe(
            Effect.flatMap(res => res.json),
            Effect.flatMap(Console.log),
            Effect.provide(GodotHttpClient.layer({})),
            Effect.runPromise,
        )
    }
}
