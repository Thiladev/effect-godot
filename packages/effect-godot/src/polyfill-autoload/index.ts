import { Node } from "godot"

import "./abort-controller.js"
// text-encoding must come before url — see text-encoding.ts.
import "./text-encoding.js"
import "./url.js"
import "./intl.js"


/**
 * Installs `Intl`, `AbortController`, `URL`/`URLSearchParams`, and
 * `TextEncoder`/`TextDecoder` on `globalThis` — none of which quickjs-ng
 * ships. Add as the *first* `[autoload]` entry so every other script sees
 * them, via a one-line re-export:
 *
 * ```ts
 * // src/GodotPolyfill.ts
 * export { default } from "effect-godot/polyfill-autoload"
 * ```
 *
 * ```ini
 * [autoload]
 * GodotPolyfill="*res://src/GodotPolyfill.ts"
 * ```
 */
export default class GodotPolyfill extends Node {}
