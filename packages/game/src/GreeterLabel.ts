import { Effect } from "effect"
import { Label } from "godot"
import GreeterRuntime, { Greeter } from "./RuntimeNodeExample.js"


export default class GreeterLabel extends GreeterRuntime.EffectfulNode(Label) {
    _ready(): void {
        super._ready()

        this.runPromise(
            Greeter.use(greeter => greeter.greet("Godot")).pipe(
                Effect.tap(message => Effect.sync(() => { this.text = message })),
            ),
        )
    }
}
