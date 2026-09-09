import { Node } from "godot"

import "./abort-controller"
// text-encoding must come before url — see text-encoding.ts.
import "./text-encoding"
import "./url"
import "./intl"

/**
 * Installs the Web platform polyfills GodotJS needs for `effect` to work:
 * `Intl`, `AbortController`/`AbortSignal`, `URL`/`URLSearchParams`, and
 * `TextEncoder`/`TextDecoder`. Each is its own module in this directory —
 * see them for what they install and why; the imports above are only
 * responsible for pulling them in, in the order that ordering-sensitive
 * ones require.
 *
 * None of GodotJS's supported engines (`qjs-ng`, `v8`, `jsc`) are guaranteed
 * to ship any of these. All four confirmed absent entirely on `qjs-ng`
 * (empirically, and at the engine-source level: none has any implementation
 * in quickjs-ng's C source to strip in the first place), and unverified
 * either way on `v8`/`jsc` — both usually ship the full Web platform surface
 * in their common configurations, but embedders routinely build with less,
 * and GodotJS fetches prebuilt binaries for those rather than building them
 * in this repo, so there's no local build config to check. This doesn't
 * need per-engine variants, because it doesn't need to know which engine
 * it's running on — every install here self-detects a native implementation
 * first and no-ops if one already exists, so importing the same fixed set
 * unconditionally is correct everywhere.
 *
 * This directory has a real, non-type-only `import ... from "godot"`
 * (`Node`, below), so it's deliberately kept out of `effect-godot`'s main
 * barrel (`src/index.ts`) and only reachable through its own subpath —
 * `effect-godot/polyfill` — since anything importing the main barrel should
 * be able to do so without requiring a `godot` runtime to exist.
 *
 * **Usage**
 *
 * Add this as the *first* entry in your project's `[autoload]` list (Godot
 * loads autoloads in list order, sequentially, before the main scene loads),
 * via a one-line re-export under your own `src/`, since Godot's autoload
 * path must resolve to a script your bundler's entry glob actually picks up.
 * `effect-godot`'s barrel modules are namespaces (matching `GodotHttpClient`,
 * `GodotRuntime`, `GodotSignal`), so the class is `GodotPolyfill.GodotPolyfill`
 * through it:
 *
 * ```ts
 * // src/GodotPolyfill.ts
 * import { GodotPolyfill } from "effect-godot/polyfill"
 *
 * export default GodotPolyfill.GodotPolyfill
 * ```
 *
 * ```ini
 * [autoload]
 * GodotPolyfill="*res://src/GodotPolyfill.ts"
 * ```
 *
 * Every other script — however many, however they're loaded — then sees
 * working `Intl`/`AbortController`/`URL`/`TextEncoder` without importing
 * anything itself: GodotJS runs one JS realm (one V8 Isolate/Context, or the
 * `qjs-ng`/`jsc` equivalent) for the whole engine on the main thread, so
 * anything installed on `globalThis` by one script is visible to all of
 * them. Only GodotJS's (experimental, opt-in) worker threads get a separate
 * realm.
 */
export class GodotPolyfill extends Node {}
