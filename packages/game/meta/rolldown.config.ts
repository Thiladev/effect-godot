import { globSync, rmSync } from "node:fs"
import { transform as esbuildTransform } from "esbuild"
import { defineConfig, type Plugin } from "rolldown"


const outDir = ".godot/GodotJS"

// Rolldown doesn't clean outDir or remove stale output itself. Only clean
// once per process — buildStart also fires on every --watch rebuild, and
// dev-watch.ts already handles the entry-list-change case.
function cleanOutDir(): Plugin {
    let cleaned = false
    return {
        name: "clean-out-dir",
        buildStart() {
            if (cleaned) return
            cleaned = true
            rmSync(outDir, { recursive: true, force: true })
        },
    }
}

// Rolldown's own transform only lowers legacy decorators, not the Stage 3
// syntax GodotJS's `@export` API needs — esbuild does, so it runs as a
// separate transform pass.
function esbuildDecorators(): Plugin {
    return {
        name: "esbuild-decorators",
        async transform(code, id) {
            if (!id.endsWith(".ts") && !id.endsWith(".tsx")) return null
            const result = await esbuildTransform(code, {
                loader: id.endsWith(".tsx") ? "tsx" : "ts",
                target: "es2022",
                sourcefile: id,
            })
            return { code: result.code }
        },
    }
}

// Every `.ts` under src (except src/shared, which is import-only — see its
// .gdignore) needs a mirrored compiled `.js`, since GodotJS's editor expects
// one for every script it can see, attached or not.
const entryFiles = globSync("src/**/*.ts", { exclude: ["src/shared/**"] })

const input = Object.fromEntries(
    entryFiles.map((file) => [file.replace(/\.ts$/, ""), file]),
)

// Provided by the GodotJS runtime itself — keep as external, not inlined.
const isEngineProvided = (id: string) =>
    id === "godot" ||
    id.startsWith("godot.") ||
    id.startsWith("godot:") ||
    id.startsWith("res://") ||
    id.startsWith("user://")

export default defineConfig({
    input,
    external: isEngineProvided,
    plugins: [cleanOutDir(), esbuildDecorators()],
    // QuickJS isn't Node — steer package.json `exports` toward browser-safe builds.
    platform: "browser",
    output: {
        dir: outDir,
        // GodotJS loads scripts via a CJS wrapper, not as native ES modules.
        format: "cjs",
        // GodotJS's loader expects the class on exports.default, not a collapsed module.exports.
        exports: "named",
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
    },
})
