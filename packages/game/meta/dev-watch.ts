import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Console, Effect, FileSystem, Option, Ref, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

// Rolldown's `input` (see rolldown.config.ts) is computed once when the
// config loads, so its own `--watch` mode never notices a file added or
// removed after startup — it only tracks the module graph of files already
// in the build. This program re-runs the same glob on every filesystem
// change under `src/`, and restarts the rolldown process whenever the
// resulting entry list actually changes.
const ENTRY_GLOB = "src/**/*.ts"
const ENTRY_EXCLUDE = ["src/shared/**"]
const ROLLDOWN_BIN = "node_modules/.bin/rolldown"
const OUT_DIR = ".godot/GodotJS"

const listEntries = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const entries = yield* fs.glob(ENTRY_GLOB, { exclude: ENTRY_EXCLUDE })
    return entries.slice().sort()
})

const program = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const currentHandle = yield* Ref.make(
        Option.none<ChildProcessSpawner.ChildProcessHandle>(),
    )
    const currentEntries = yield* Ref.make(yield* listEntries)

    const restart = Effect.gen(function* () {
        const previous = yield* Ref.get(currentHandle)
        if (Option.isSome(previous))
            yield* previous.value.kill().pipe(Effect.ignore)

        // Rolldown never removes output files that a previous run emitted but
        // the current entry list no longer produces — clear the dir on every
        // (re)start so a removed entrypoint doesn't leave a stale, still-loadable
        // script behind.
        yield* fs
            .remove(OUT_DIR, { recursive: true, force: true })
            .pipe(Effect.ignore)

        const handle = yield* spawner.spawn(
            ChildProcess.make(
                ROLLDOWN_BIN,
                ["-c", "meta/rolldown.config.ts", "--watch"],
                {
                    stdin: "inherit",
                    stdout: "inherit",
                    stderr: "inherit",
                },
            ),
        )
        yield* Ref.set(currentHandle, Option.some(handle))
    })

    yield* restart

    // Debounced so a batch of changes (e.g. `git checkout` touching many
    // files) triggers one restart instead of several. Only a change to the
    // *entry list* itself (a file added or removed) causes a restart — an
    // edit to an existing file re-globs to the same list and is dropped.
    yield* fs.watch("src", { recursive: true }).pipe(
        Stream.filter((event) => event.path.endsWith(".ts")),
        Stream.debounce("100 millis"),
        Stream.mapEffect(() =>
            Effect.gen(function* () {
                const next = yield* listEntries
                const previous = yield* Ref.get(currentEntries)
                const changed = next.join("\n") !== previous.join("\n")
                if (changed) yield* Ref.set(currentEntries, next)
                return changed
            }),
        ),
        Stream.filter((changed) => changed),
        Stream.runForEach(() =>
            Console.log(
                "[dev-watch] entrypoints changed, restarting rolldown...",
            ).pipe(Effect.andThen(restart)),
        ),
    )
}).pipe(Effect.scoped)

program.pipe(Effect.provide(BunServices.layer), BunRuntime.runMain)
