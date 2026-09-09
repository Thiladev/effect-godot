import { Node } from "godot"

// Neither published polyfill's own auto-install script checks `globalThis`
// (only `self`/`window`/`global`, or nothing at all) — GodotJS defines none
// of the former, so their self-detection would silently find nothing and
// skip installing. Importing the concrete implementations directly
// (bypassing `abort-controller`'s `browser` field, which points at a
// passthrough that reads `self`/`window` and would export `undefined` here)
// and doing our own `globalThis` checks instead avoids that trap.
import { AbortController, AbortSignal } from "abort-controller/dist/abort-controller.js"
if (typeof (globalThis as { AbortController?: unknown }).AbortController === "undefined") {
    Object.assign(globalThis, { AbortController, AbortSignal })
}

// Must be imported (not just installed via inline code) before the
// `whatwg-url` import below: `whatwg-url`'s IDNA/host processing needs
// `TextEncoder` at *module-evaluation* time, and ES module `import`
// declarations are hoisted and evaluated in file order before any of this
// file's own top-level code runs — so only another `import` at an earlier
// position actually guarantees the ordering. See GodotTextEncoding.ts.
import "./GodotTextEncoding"

import { URL, URLSearchParams } from "whatwg-url"
if (typeof (globalThis as { URL?: unknown }).URL === "undefined") {
    Object.assign(globalThis, { URL, URLSearchParams })
}

import "@formatjs/intl-getcanonicallocales/polyfill.js"
import "@formatjs/intl-locale/polyfill.js"
import "@formatjs/intl-pluralrules/polyfill.js"
import "@formatjs/intl-pluralrules/locale-data/en.js"
import "@formatjs/intl-listformat/polyfill.js"
import "@formatjs/intl-listformat/locale-data/en.js"
import "@formatjs/intl-numberformat/polyfill.js"
import "@formatjs/intl-numberformat/locale-data/en.js"
import "@formatjs/intl-datetimeformat/polyfill.js"
import "@formatjs/intl-datetimeformat/locale-data/en.js"
import "@formatjs/intl-datetimeformat/add-golden-tz.js"

/**
 * Installs the Web platform polyfills GodotJS needs for `effect` to work:
 * `Intl`, `AbortController`/`AbortSignal`, `URL`/`URLSearchParams`, and
 * `TextEncoder`/`TextDecoder`.
 *
 * None of GodotJS's supported engines (`qjs-ng`, `v8`, `jsc`) are guaranteed
 * to ship any of these. All four confirmed absent entirely on `qjs-ng`
 * (empirically, and at the engine-source level: none has any implementation
 * in quickjs-ng's C source to strip in the first place), and unverified
 * either way on `v8`/`jsc` — both usually ship the full Web platform surface
 * in their common configurations, but embedders routinely build with less,
 * and GodotJS fetches prebuilt binaries for those rather than building them
 * in this repo, so there's no local build config to check.
 *
 * This doesn't need per-engine variants, because it doesn't need to know
 * which engine it's running on. Each piece self-detects a native
 * implementation first and no-ops if one already exists — FormatJS's own
 * `should-polyfill.ts` for `Intl`; a `globalThis` check written here for
 * everything else, since none of the published packages' own auto-install
 * logic checks `globalThis` (only `self`/`window`/`global`, or nothing) — so
 * importing the same fixed set unconditionally is correct everywhere: real
 * work on an engine missing any of these, a no-op (aside from the bundled
 * data still shipping) on one that already has them.
 *
 * Without this:
 * - Anything in `effect`'s `DateTime` module that isn't UTC/fixed-offset
 *   breaks (`DateTime.format`/`formatLocal`/`formatUtc`, and creating any
 *   *named* IANA time zone via `DateTime.zoneMakeNamed`), since both call
 *   `new Intl.DateTimeFormat` directly with no service-level indirection to
 *   intercept.
 * - Every request through `effect`'s `HttpClient` — including
 *   `GodotHttpClient` — throws `ReferenceError: AbortController is not
 *   defined`, since `HttpClient.make`'s postprocessing wrapper constructs
 *   one unconditionally for every request, before ever reaching a
 *   transport's own code.
 * - Every request also fails with `HttpClientError: InvalidUrl error`
 *   before it's even sent, since `HttpClientRequest`'s URL resolution
 *   constructs a `new URL(...)` directly, with the same no-service-seam
 *   problem.
 * - Fixing the previous point cascades into a fourth gap: the `URL`
 *   polyfill's own IDNA/host processing needs `TextEncoder` to
 *   punycode-encode non-ASCII hostnames, and throws
 *   `ReferenceError: TextEncoder is not defined` at *module-evaluation*
 *   time — which, because this all lives in one bundled chunk, takes down
 *   every other polyfill installed here too, not just `URL`.
 *
 * **Usage**
 *
 * Add this as the *first* entry in your project's `[autoload]` list (Godot
 * loads autoloads in list order, sequentially, before the main scene loads),
 * via a one-line re-export under your own `src/`, since Godot's autoload
 * path must resolve to a script your bundler's entry glob actually picks up:
 *
 * ```ts
 * // src/GodotPolyfill.ts
 * export { GodotPolyfill as default } from "effect-godot"
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
 * them. Only GodotJS's
 * (experimental, opt-in) worker threads get a separate realm.
 *
 * Only the "en" locale and the common ("golden") time zone subset are
 * loaded for `Intl`, to keep bundle size down — this pulled a multi-MB
 * dependency tree in practice. If your game ships more locales, or needs
 * the full IANA zone list, fork this file rather than editing it in place,
 * since every consumer of this package shares it.
 */
export class GodotPolyfill extends Node {}
