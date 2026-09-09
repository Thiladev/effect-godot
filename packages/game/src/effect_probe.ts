import { Node } from "godot"
import { DateTime, Effect, Fiber, Schema, Stream } from "effect"
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

        // Schema is the module most likely to lean on platform APIs
        // (Date parsing, regex, Intl) rather than just Effect's own
        // scheduler/data-structure code.
        const PersonSchema = Schema.Struct({
            id: Schema.String.pipe(Schema.check(Schema.isUUID())),
            name: Schema.NonEmptyString,
            age: Schema.Int,
            role: Schema.Literals(["admin", "member"]),
            tags: Schema.Array(Schema.String),
        })

        await this.check("Schema.Struct decode/encode round trip (UUID regex, Int, Literals, Array checks)", () =>
            Effect.gen(function* () {
                const input = {
                    id: "123e4567-e89b-12d3-a456-426614174000",
                    name: "Ada",
                    age: 30,
                    role: "admin",
                    tags: ["founder", "engineer"],
                }
                const decoded = yield* Schema.decodeUnknownEffect(PersonSchema)(input)
                const encoded = yield* Schema.encodeEffect(PersonSchema)(decoded)
                if (JSON.stringify(encoded) !== JSON.stringify(input)) {
                    throw new Error(`round trip mismatch: ${JSON.stringify(encoded)}`)
                }
            }),
        )

        await this.check("Schema.DateFromString (Date parsing)", () =>
            Effect.gen(function* () {
                const date = yield* Schema.decodeUnknownEffect(Schema.DateFromString)(
                    "2024-06-15T14:30:00.000Z",
                )
                if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
                    throw new Error(`invalid Date: ${date}`)
                }
                if (date.getUTCFullYear() !== 2024) {
                    throw new Error(`unexpected year: ${date.getUTCFullYear()}`)
                }
            }),
        )

        await this.check("Schema.DateTimeUtcFromString + Intl.DateTimeFormat", () =>
            Effect.gen(function* () {
                const dt = yield* Schema.decodeUnknownEffect(Schema.DateTimeUtcFromString)(
                    "2024-06-15T14:30:00.000Z",
                )
                const formatter = new Intl.DateTimeFormat("en-US", {
                    year: "numeric",
                    month: "long",
                    day: "numeric",
                    timeZone: "UTC",
                })
                const formatted = DateTime.formatIntl(dt, formatter)
                if (formatted.length === 0) {
                    throw new Error("Intl.DateTimeFormat produced an empty string")
                }
                console.log(`[EffectProbe]   Intl.DateTimeFormat output: ${formatted}`)
            }),
        )

        // formatIntl above only proves the polyfill works when *we* construct
        // the formatter. DateTime.format/formatLocal and zoneMakeNamed call
        // `new Intl.DateTimeFormat` themselves, internally, with no service
        // seam to intercept (see internal/dateTime.ts) — this is what was
        // actually broken before the polyfill, so it's the real regression
        // check.
        await this.check("DateTime.format (effect's own internal Intl.DateTimeFormat call)", () =>
            Effect.gen(function* () {
                const dt = DateTime.makeUnsafe("2024-06-15T14:30:00Z")
                const formatted = DateTime.format(dt, {
                    locale: "en-US",
                    year: "numeric",
                    month: "long",
                    day: "numeric",
                    timeZone: "utc",
                })
                if (formatted.length === 0) throw new Error("DateTime.format produced an empty string")
                console.log(`[EffectProbe]   DateTime.format output: ${formatted}`)
            }),
        )

        await this.check("DateTime.zoneMakeNamed (named IANA zone, needs Intl for tz offsets)", () =>
            Effect.gen(function* () {
                const zone = DateTime.zoneMakeNamedUnsafe("Europe/London")
                const dt = DateTime.setZone(DateTime.makeUnsafe("2024-06-15T14:30:00Z"), zone)
                const formatted = DateTime.formatLocal(dt, { year: "numeric", month: "short", day: "numeric" })
                if (formatted.length === 0) throw new Error("formatLocal produced an empty string")
                console.log(`[EffectProbe]   Europe/London formatLocal output: ${formatted}`)
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
