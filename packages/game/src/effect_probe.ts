import { Node } from "godot"
import { Effect, Fiber, Stream } from "effect"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import { GodotRuntime, GodotHttpClient } from "effect-godot"

/**
 * Autoloaded probe to check whether Effect (and effect-godot) run natively
 * on GodotJS's quickjs-ng engine, or need polyfilling. Each check is
 * isolated so one failure doesn't hide the rest; results print to the Godot
 * console. Not meant to stay wired up long-term.
 */
export default class EffectProbe extends Node {
    async _ready() {
        console.log("[EffectProbe] starting")

        await this.check("core Effect.gen + map + succeed", () =>
            Effect.gen(function* () {
                const value = yield* Effect.succeed(1).pipe(Effect.map((n: number) => n + 1))
                if (value !== 2) throw new Error(`expected 2, got ${value}`)
            }),
        )

        await this.check("Effect.sleep (Clock / timer scheduling)", () =>
            Effect.gen(function* () {
                const start = Date.now()
                yield* Effect.sleep("20 millis")
                if (Date.now() - start < 10) throw new Error("did not actually wait")
            }),
        )

        await this.check("Fiber fork/join (scheduler, concurrency)", () =>
            Effect.gen(function* () {
                const fiber = yield* Effect.forkDetach(Effect.succeed(42))
                const result = yield* Fiber.join(fiber)
                if (result !== 42) throw new Error(`expected 42, got ${result}`)
            }),
        )

        await this.check("Stream (fromIterable + runCollect)", () =>
            Effect.gen(function* () {
                const values = yield* Stream.runCollect(Stream.fromIterable([1, 2, 3]))
                if (values.join(",") !== "1,2,3") throw new Error(`unexpected: ${values}`)
            }),
        )

        await this.check("effect/unstable/http module resolution", () =>
            Effect.sync(() => {
                const request = HttpClientRequest.get("https://example.test/")
                if (request.url !== "https://example.test/") {
                    throw new Error(`unexpected url: ${request.url}`)
                }
            }),
        )

        await this.check("effect-godot package resolution (GodotRuntime, GodotHttpClient)", () =>
            Effect.sync(() => {
                if (GodotRuntime.GodotRuntimeLayer === undefined) {
                    throw new Error("GodotRuntimeLayer is undefined")
                }
                if (typeof GodotHttpClient.make !== "function") {
                    throw new Error("GodotHttpClient.make is not a function")
                }
            }),
        )

        console.log("[EffectProbe] done")
        this.get_tree()?.quit()
    }

    private async check(name: string, program: () => Effect.Effect<void, unknown>) {
        try {
            await Effect.runPromise(program())
            console.log(`[EffectProbe] PASS: ${name}`)
        } catch (error) {
            console.log(`[EffectProbe] FAIL: ${name}`)
            console.log(String(error))
            if (error instanceof Error && error.stack) console.log(error.stack)
        }
    }
}
