// Installs `AbortController`/`AbortSignal` onto `globalThis` if missing.
// quickjs-ng has no implementation at all (confirmed empirically and at the
// engine-source level — see `GodotPolyfill.ts` for the full rationale).
// `effect`'s own `HttpClient.make` constructs one unconditionally for every
// request, before any transport-specific code runs, so this affects any
// `effect` HTTP client, not just `GodotHttpClient`.
//
// `abort-controller`'s own auto-install script (`abort-controller/polyfill`)
// only checks `self`/`window`/`global` for an existing implementation —
// GodotJS defines none of those, only `globalThis` — so its self-detection
// would silently find nothing and skip installing. Importing the concrete
// implementation directly (bypassing the package's `browser` field, which
// points at a passthrough that reads `self`/`window` and would export
// `undefined` here) and doing our own `globalThis` check instead avoids
// that trap.
import { AbortController, AbortSignal } from "abort-controller/dist/abort-controller.js"

if (typeof (globalThis as { AbortController?: unknown }).AbortController === "undefined") {
    Object.assign(globalThis, { AbortController, AbortSignal })
}
