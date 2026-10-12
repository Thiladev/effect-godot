import { Effect, Stream } from "effect"
import { LanguageModel } from "effect/ai"
import { Label } from "godot"
import Runtime from "./Runtime.js"


export default class AiExampleLabel extends Runtime.Effectful(Label) {
    _ready(): void {
        this.text = ""
        this.runPromise(
            LanguageModel.streamText({
                prompt: "Write a haiku about the Godot game engine.",
            }).pipe(
                Stream.runForEach((part): Effect.Effect<void> =>
                    part.type === "text-delta"
                        ? Effect.sync(() => { this.text += part.delta })
                        : Effect.void
                ),
                Effect.catch(error => Effect.sync(() => { this.text = `Error: ${String(error)}` })),
            ),
        )
    }
}
