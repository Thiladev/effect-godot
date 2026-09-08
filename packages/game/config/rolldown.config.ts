import { globSync } from "node:fs"
import { transform as esbuildTransform } from "esbuild"
import { defineConfig, type Plugin } from "rolldown"

// Rolldown's own (oxc-based) transform only lowers legacy
// (experimentalDecorators-style) decorators, not the Stage 3 syntax
// GodotJS's `createClassBinder()`/`@export` API is built for — QuickJS
// doesn't understand that syntax natively, so scripts using it fail to load
// ("invalid property name") rather than erroring at build time. esbuild has
// supported lowering Stage 3 decorators since 0.21 (mid-2024), so it runs as
// a transform pass here instead.
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

// GodotJS resolves each `.ts` script attached in the editor to a compiled
// `.js` file at the same relative path under `.godot/GodotJS/` (which Godot
// hides from the editor's filesystem dock, since it's a dot-directory).
// GodotJS's editor also expects a mirrored `.js` for *every* `.ts` it can
// see in the project, whether or not it's attached anywhere — so files that
// are only ever imported (never attached to a Node) live under `src/shared`,
// which carries a `.gdignore` to keep the editor from scanning it at all.
// Rolldown folds `src/shared` modules into whichever entrypoints import
// them, splitting into a shared chunk when more than one entry uses it.
const entryFiles = globSync("src/**/*.ts", { exclude: ["src/shared/**"] })

const input = Object.fromEntries(
    entryFiles.map((file) => [file.replace(/\.ts$/, ""), file]),
)

// Modules the GodotJS runtime provides itself (the "godot" API namespace and
// `res://`/`user://` resource imports) — these have no source to bundle and
// must stay as runtime-resolved imports rather than being inlined.
const isEngineProvided = (id: string) =>
    id === "godot" ||
    id.startsWith("godot.") ||
    id.startsWith("godot:") ||
    id.startsWith("res://") ||
    id.startsWith("user://")

export default defineConfig({
    input,
    external: isEngineProvided,
    plugins: [esbuildDecorators()],
    // The QuickJS runtime GodotJS embeds is not Node — resolving deps as
    // "browser" steers package.json `exports` conditions away from
    // Node-only builtins (e.g. nanoid's `node:crypto` entrypoint) toward
    // builds that only rely on standard JS globals.
    platform: "browser",
    output: {
        dir: ".godot/GodotJS",
        // GodotJS loads compiled scripts through a CommonJS-style
        // function(exports, require, module, __filename, __dirname) wrapper,
        // not as native ES modules, so `import`/`export` syntax at the top
        // level of the emitted file fails to parse.
        format: "cjs",
        // GodotJS's script loader looks for the script class on `exports.default`
        // (matching tsc's CJS interop shape for `export default class ...`), not
        // on a collapsed `module.exports =`, which is rolldown/rollup's default
        // for a module with only a default export.
        exports: "named",
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
    },
})
