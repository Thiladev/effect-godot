import { describe, expect, it } from "bun:test"
import { Effect, Fiber } from "effect"
import { once, subscribe, type GodotSignal } from "../src/index"

class TestSignal<Args extends readonly unknown[]>
    implements GodotSignal<Args>
{
    readonly listeners = new Set<(...args: Args) => void>()

    connect(listener: (...args: Args) => void): void {
        this.listeners.add(listener)
    }

    disconnect(listener: (...args: Args) => void): void {
        this.listeners.delete(listener)
    }

    emit(...args: Args): void {
        for (const listener of this.listeners) listener(...args)
    }
}

describe("GodotSignal", () => {
    it("waits for one emission and disconnects", async () => {
        const signal = new TestSignal<[string, number]>()
        const fiber = Effect.runFork(once(signal))

        expect(signal.listeners.size).toBe(1)
        signal.emit("ready", 42)

        await expect(Effect.runPromise(Fiber.join(fiber))).resolves.toEqual([
            "ready",
            42,
        ])
        expect(signal.listeners.size).toBe(0)
    })

    it("disconnects a scoped subscription", async () => {
        const signal = new TestSignal<[string]>()
        const program = Effect.scoped(
            Effect.gen(function* () {
                yield* subscribe(signal, () => undefined)
                return signal.listeners.size
            }),
        )

        await expect(Effect.runPromise(program)).resolves.toBe(1)
        expect(signal.listeners.size).toBe(0)
    })

    it("disconnects a once listener when its fiber is interrupted", async () => {
        const signal = new TestSignal<[string]>()
        const fiber = Effect.runFork(once(signal))

        await Effect.runPromise(Fiber.interrupt(fiber))

        expect(signal.listeners.size).toBe(0)
    })
})
