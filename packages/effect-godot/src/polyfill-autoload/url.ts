// Installs `URL`/`URLSearchParams` onto `globalThis` if missing. Must be
// imported *after* `./text-encoding` in `polyfill-autoload/index.ts` — see that
// module's comment for why the ordering between sibling imports matters
// here specifically.
//
// quickjs-ng has no `URL` implementation at all (confirmed empirically and
// at the engine-source level — see `GodotPolyfill.ts` for the full
// rationale). `effect`'s `HttpClientRequest` resolves request URLs with a
// direct `new URL(...)` call, with no service-level indirection to
// intercept, so every request fails with `HttpClientError: InvalidUrl
// error` before it's even sent without this.
//
// `whatwg-url` is the WHATWG URL Standard's reference implementation
// (verified: no Node built-in dependency anywhere in its transitive chain —
// `webidl-conversions`, `tr46`, `punycode`). Its default export installs
// onto a `sharedGlobalObject` object it owns internally, not `globalThis`,
// so — same as the rest of this directory — the actual `globalThis` install
// is done here explicitly rather than relying on any auto-install behavior.
import { URL, URLSearchParams } from "whatwg-url"

if (typeof (globalThis as { URL?: unknown }).URL === "undefined") {
    Object.assign(globalThis, { URL, URLSearchParams })
}
