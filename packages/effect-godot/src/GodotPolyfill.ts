import { Node } from "godot"

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
 * Installs an `Intl` polyfill for GodotJS.
 *
 * None of GodotJS's supported engines (`qjs-ng`, `v8`, `jsc`) are guaranteed
 * to ship a working `Intl`. Confirmed absent entirely on `qjs-ng` (empirically,
 * and at the engine-source level: quickjs-ng has no `Intl` implementation to
 * strip in the first place), and unverified either way on `v8`/`jsc` — both
 * usually ship full ICU in their common configurations, but embedders
 * routinely build with reduced or no ICU to cut binary size, and GodotJS
 * fetches prebuilt binaries for those rather than building them in this
 * repo, so there's no local build config to check.
 *
 * This doesn't need per-engine variants, because it doesn't need to know
 * which engine it's running on. Each FormatJS polyfill it installs
 * self-detects a native implementation first and no-ops if one already
 * exists (see each package's `should-polyfill.ts`), so importing the same
 * fixed set unconditionally is correct everywhere: it does real work on an
 * engine with no `Intl`, and it's a no-op (aside from the bundled locale/tz
 * data still shipping) on one that already has it.
 *
 * Without this, anything in `effect`'s `DateTime` module that isn't
 * UTC/fixed-offset breaks: `DateTime.format`/`formatLocal`/`formatUtc`, and
 * creating any *named* IANA time zone via `DateTime.zoneMakeNamed`, both call
 * `new Intl.DateTimeFormat` directly with no service-level indirection to
 * intercept.
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
 * Every other script — however many, however they're loaded — then sees a
 * working `Intl` without importing anything itself: GodotJS runs one JS
 * realm (one V8 Isolate/Context, or the `qjs-ng`/`jsc` equivalent) for the
 * whole engine on the main thread, so `globalThis.Intl` installed by one
 * script is visible to all of them. Only GodotJS's (experimental, opt-in)
 * worker threads get a separate realm.
 *
 * Only the "en" locale and the common ("golden") time zone subset are
 * loaded, to keep bundle size down — this pulled a ~2MB dependency tree in
 * practice. If your game ships more locales, or needs the full IANA zone
 * list, fork this file rather than editing it in place, since every consumer
 * of this package shares it.
 */
export class GodotPolyfill extends Node {}
