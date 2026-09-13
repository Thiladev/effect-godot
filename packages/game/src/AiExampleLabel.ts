import { Effect } from "effect"
import { LanguageModel } from "effect/unstable/ai"
import { Label } from "godot"
import Runtime from "./Runtime.js"


export default class AiExampleLabel extends Runtime.EffectfulNode(Label) {
    _ready(): void {
        this.text = "Asking OpenRouter..."
        this.runPromise(
            LanguageModel.generateText({
                prompt: "Write a haiku about the Godot game engine.",
            }).pipe(
                Effect.tap(response => Effect.sync(() => { this.text = response.text })),
                Effect.catch(error => Effect.sync(() => { this.text = `Error: ${String(error)}` })),
            ),
        )
    }
}
