import { Effect } from "effect"
import { Label } from "godot"
import GreeterRuntime, { Greeter } from "./RuntimeNodeExample.js"


export default class GreeterLabel extends GreeterRuntime.Effectful(Label) {
    _ready(): void {
        this.runPromise(
            Greeter.use(greeter => greeter.greet("Godot")).pipe(
                Effect.tap(message => Effect.sync(() => { this.text = message })),
            ),
        )
    }
}
