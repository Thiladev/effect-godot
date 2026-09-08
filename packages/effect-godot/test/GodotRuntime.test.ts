import { describe, expect, it } from "bun:test"
import { Effect, Fiber } from "effect"
import { GodotRuntimeLayer, runFork } from "../src/index"

describe("GodotRuntime", () => {
    it("forks work into the provided runtime layer", async () => {
        const program = Effect.gen(function* () {
            const fiber = yield* runFork(Effect.succeed("done"))
            return yield* Fiber.join(fiber)
        }).pipe(Effect.provide(GodotRuntimeLayer))

        await expect(Effect.runPromise(program)).resolves.toBe("done")
    })
})
