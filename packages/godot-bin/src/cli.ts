#!/usr/bin/env bun
/**
 * Downloads and caches the GodotJS-flavored Godot editor binary pinned by a
 * package's `godot.config.json`, inside that package's own `.godot-bin/`
 * directory (never a global/user-wide location). GodotJS ships full custom
 * Godot builds per release (tied to a JS engine variant), so plain
 * godotengine.org downloads or a system-wide `godot` won't work here.
 *
 * Also fetches the platform CEF runtime binaries for the godot-cef addon
 * (pinned by `godot-cef.config.json`) directly into `addons/godot_cef/bin`,
 * since those binaries are ~1GB and platform-specific and so aren't
 * committed to the repository.
 *
 * Usage:
 *   godot-bin --project <dir> path              print the resolved Godot binary path
 *   godot-bin --project <dir> fetch              ensure the Godot binary is downloaded
 *   godot-bin --project <dir> run -- <args...>   run the Godot binary with args
 *   godot-bin --project <dir> cef fetch          ensure the godot-cef addon binaries are downloaded
 */

import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Console, Effect, FileSystem, Layer, Option, Path, Schema } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { FetchHttpClient, HttpClient } from "effect/http"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

class GodotBinError extends Schema.TaggedError<GodotBinError>()(
    "GodotBinError",
    {
        cause: Schema.Defect(),
    },
) {}

class GodotConfig extends Schema.Class<GodotConfig>("GodotConfig")({
    repo: Schema.String,
    tag: Schema.String,
    godotVersion: Schema.String,
    engine: Schema.Literals(["qjs-ng", "v8", "jsc"]),
}) {}

class CefConfig extends Schema.Class<CefConfig>("CefConfig")({
    repo: Schema.String,
    tag: Schema.String,
    asset: Schema.String,
}) {}

const loadJsonConfig = <S extends Schema.Constraint>(
    schema: S,
    projectDir: string,
    fileName: string,
) =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const configPath = path.join(projectDir, fileName)

        if (!(yield* fs.exists(configPath))) {
            return yield* new GodotBinError({
                cause: new Error(`No ${fileName} found at ${configPath}`),
            })
        }

        const text = yield* fs.readFileString(configPath)
        const json = yield* Effect.try({
            try: () => JSON.parse(text) as unknown,
            catch: (cause) => new GodotBinError({ cause }),
        })
        return yield* Schema.decodeUnknownEffect(schema)(json)
    })

const platformName = Effect.gen(function* () {
    switch (process.platform) {
        case "linux":
            return "linux" as const
        case "darwin":
            return "macos" as const
        case "win32":
            return "windows" as const
        default:
            return yield* new GodotBinError({
                cause: new Error(`Unsupported platform: ${process.platform}`),
            })
    }
})

const loadConfig = (projectDir: string) =>
    loadJsonConfig(GodotConfig, projectDir, "godot.config.json")

const loadCefConfig = (projectDir: string) =>
    loadJsonConfig(CefConfig, projectDir, "godot-cef.config.json")

// GodotJS's editor scans every file under the extracted archive; we don't
// know the exact binary name for every platform/release, so we pick the
// largest file that looks like a Godot executable instead of hardcoding one.
const findBinary = (dir: string) =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const isWin = process.platform === "win32"

        const entries = yield* fs.readDirectory(dir, { recursive: true })
        const infos = yield* Effect.forEach(
            entries,
            (entry) =>
                Effect.gen(function* () {
                    const full = path.join(dir, entry)
                    const info = yield* fs.stat(full)
                    return { full, entry, info }
                }),
            { concurrency: 8 },
        )

        const files = infos.filter(({ info }) => info.type === "File")
        const candidates = files.filter(({ entry }) => {
            const name = path.basename(entry)
            return isWin
                ? name.toLowerCase().endsWith(".exe")
                : name.startsWith("godot")
        })
        const pool = candidates.length > 0 ? candidates : files

        const best = pool.reduce<(typeof pool)[number] | undefined>(
            (acc, cur) => (!acc || cur.info.size > acc.info.size ? cur : acc),
            undefined,
        )

        return Option.fromNullishOr(best?.full)
    })

const extractZip = (zipPath: string, destDir: string) =>
    Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const command =
            process.platform === "win32"
                ? ChildProcess.make("powershell", [
                      "-NoProfile",
                      "-Command",
                      `Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force`,
                  ])
                : ChildProcess.make("unzip", [
                      "-q",
                      "-o",
                      zipPath,
                      "-d",
                      destDir,
                  ])

        const exitCode = yield* spawner.exitCode(command)
        if (exitCode !== ChildProcessSpawner.ExitCode(0)) {
            return yield* new GodotBinError({
                cause: new Error(
                    `Failed to extract ${zipPath} (exit code ${exitCode})`,
                ),
            })
        }
    })

const downloadFile = (url: string, destPath: string) =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const client = (yield* HttpClient.HttpClient).pipe(
            HttpClient.filterStatusOk,
        )

        yield* Console.error(`[godot-bin] downloading ${url}`)
        const response = yield* client.get(url)
        const buffer = yield* response.arrayBuffer
        yield* fs.writeFile(destPath, new Uint8Array(buffer))
    })

const ensureBinary = (projectDir: string) =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path

        const config = yield* loadConfig(projectDir)
        const platform = yield* platformName

        const cacheKey = `${config.tag}-${platform}-${config.engine}`
        const cacheDir = path.join(projectDir, ".godot-bin", cacheKey)
        const markerFile = path.join(cacheDir, ".complete")
        const resolvedFile = path.join(cacheDir, ".binary-path")

        if (
            (yield* fs.exists(markerFile)) &&
            (yield* fs.exists(resolvedFile))
        ) {
            const relative = yield* fs.readFileString(resolvedFile)
            return path.join(cacheDir, relative.trim())
        }

        yield* fs.remove(cacheDir, { recursive: true, force: true })
        yield* fs.makeDirectory(cacheDir, { recursive: true })

        const asset = `${platform}-editor-${config.godotVersion}-${config.engine}.zip`
        const url = `https://github.com/${config.repo}/releases/download/${config.tag}/${asset}`
        const zipPath = path.join(cacheDir, asset)

        yield* downloadFile(url, zipPath)

        yield* Console.error(`[godot-bin] extracting ${asset}`)
        yield* extractZip(zipPath, cacheDir)
        yield* fs.remove(zipPath)

        const binaryPath = yield* findBinary(cacheDir)
        if (Option.isNone(binaryPath)) {
            return yield* new GodotBinError({
                cause: new Error(
                    `Could not locate a Godot binary inside ${cacheDir}`,
                ),
            })
        }

        if (process.platform !== "win32") {
            yield* fs.chmod(binaryPath.value, 0o755)
        }

        yield* fs.writeFileString(
            resolvedFile,
            path.relative(cacheDir, binaryPath.value),
        )
        yield* fs.writeFileString(markerFile, new Date().toISOString())

        return binaryPath.value
    }).pipe(
        Effect.mapError((cause) =>
            cause instanceof GodotBinError
                ? cause
                : new GodotBinError({ cause }),
        ),
    )

// The godot-cef release zip is a full build-output tree, wrapping the addon
// at `dist/addons/godot_cef`; the actual bin/ payload is ~1GB and
// platform-specific, so it's fetched here rather than committed.
const ensureCefAddon = (projectDir: string) =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path

        const config = yield* loadCefConfig(projectDir)
        const addonDir = path.join(projectDir, "addons", "godot_cef")
        const binDir = path.join(addonDir, "bin")
        const markerFile = path.join(binDir, ".complete")

        if (yield* fs.exists(markerFile)) {
            return addonDir
        }

        const workDir = path.join(projectDir, ".godot-bin", `cef-${config.tag}`)
        yield* fs.remove(workDir, { recursive: true, force: true })
        yield* fs.makeDirectory(workDir, { recursive: true })

        const url = `https://github.com/${config.repo}/releases/download/${config.tag}/${config.asset}`
        const zipPath = path.join(workDir, config.asset)

        yield* downloadFile(url, zipPath)

        yield* Console.error(`[godot-bin] extracting ${config.asset}`)
        yield* extractZip(zipPath, workDir)

        const extractedAddonDir = path.join(
            workDir,
            "dist",
            "addons",
            "godot_cef",
        )
        if (!(yield* fs.exists(extractedAddonDir))) {
            return yield* new GodotBinError({
                cause: new Error(
                    `Expected ${config.asset} to contain dist/addons/godot_cef, but it didn't`,
                ),
            })
        }

        yield* fs.remove(addonDir, { recursive: true, force: true })
        yield* fs.rename(extractedAddonDir, addonDir)
        yield* fs.remove(workDir, { recursive: true, force: true })

        if (process.platform !== "win32") {
            // Zip extraction doesn't reliably preserve the executable bit; CEF's
            // helper subprocesses (extensionless files, unlike its .so/.pak/.dat
            // data files) need it set explicitly to be launchable.
            const entries = yield* fs.readDirectory(binDir, { recursive: true })
            yield* Effect.forEach(
                entries,
                (entry) =>
                    Effect.gen(function* () {
                        const full = path.join(binDir, entry)
                        const info = yield* fs.stat(full)
                        if (
                            info.type === "File" &&
                            path.extname(entry) === ""
                        ) {
                            yield* fs.chmod(full, 0o755)
                        }
                    }),
                { concurrency: 8 },
            )
        }

        yield* fs.writeFileString(markerFile, new Date().toISOString())

        return addonDir
    }).pipe(
        Effect.mapError((cause) =>
            cause instanceof GodotBinError
                ? cause
                : new GodotBinError({ cause }),
        ),
    )

const project = Flag.Directory("project", { mustExist: true }).pipe(
    Flag.withDescription(
        "Godot project directory containing godot.config.json",
    ),
    Flag.withDefault("."),
)

const root = Command.make("godot-bin").pipe(
    Command.withSharedFlags({ project }),
    Command.withDescription(
        "Manage this project's pinned GodotJS/Godot editor binary",
    ),
)

const pathCommand = Command.make("path", {}, () =>
    Effect.gen(function* () {
        const { project } = yield* root
        const binary = yield* ensureBinary(project)
        yield* Console.log(binary)
    }),
).pipe(
    Command.withDescription(
        "Print the resolved binary path, downloading it first if needed",
    ),
)

const fetchCommand = Command.make("fetch", {}, () =>
    Effect.gen(function* () {
        const { project } = yield* root
        const binary = yield* ensureBinary(project)
        yield* Console.error(`[godot-bin] ready: ${binary}`)
    }),
).pipe(Command.withDescription("Ensure the binary is downloaded"))

const runCommand = Command.make(
    "run",
    { args: Argument.variadic(Argument.String("args")) },
    ({ args }) =>
        Effect.gen(function* () {
            const { project } = yield* root
            const binary = yield* ensureBinary(project)
            const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
            const commandArgs: ReadonlyArray<string> = args
            const commandOptions: ChildProcess.CommandOptions = {
                cwd: project,
                stdin: "inherit",
                stdout: "inherit",
                stderr: "inherit",
                env: { GODOT: binary },
                extendEnv: true,
            }

            const exitCode = yield* spawner
                .exitCode(
                    ChildProcess.make(binary, commandArgs, commandOptions),
                )
                .pipe(Effect.mapError((cause) => new GodotBinError({ cause })))

            yield* Effect.sync(() => process.exit(exitCode))
        }),
).pipe(
    Command.withDescription("Run the binary, forwarding the given arguments"),
)

const cefFetchCommand = Command.make("fetch", {}, () =>
    Effect.gen(function* () {
        const { project } = yield* root
        const addonDir = yield* ensureCefAddon(project)
        yield* Console.error(`[godot-bin] ready: ${addonDir}`)
    }),
).pipe(
    Command.withDescription(
        "Download the godot-cef addon's platform CEF runtime binaries",
    ),
)

const cefCommand = Command.make("cef").pipe(
    Command.withSubcommands([cefFetchCommand]),
    Command.withDescription("Manage the bundled godot-cef WebView addon"),
)

root.pipe(
    Command.withSubcommands([
        pathCommand,
        fetchCommand,
        runCommand,
        cefCommand,
    ]),
    Command.run({ version: "0.0.0" }),
    Effect.provide(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer)),
    BunRuntime.runMain,
)
