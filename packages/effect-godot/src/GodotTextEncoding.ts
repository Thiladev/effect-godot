// Split out of `GodotPolyfill.ts` so it's its own `import` declaration, not
// inline code sitting between two other imports. ES module `import`
// declarations are hoisted and evaluated in file order *before* any of the
// importing module's own top-level code runs, regardless of where that code
// is written relative to the imports — so a self-install written as plain
// statements between `import { AbortController } from "..."` and
// `import { URL } from "whatwg-url"` actually still runs *after* `whatwg-url`
// (and its transitive `TextEncoder` dependency) has already been evaluated.
// Making this its own module, imported before the `whatwg-url` import in
// `GodotPolyfill.ts`, is what actually gets the ordering right.
//
// quickjs-ng has no TextEncoder/TextDecoder either (the same story as
// everything else `GodotPolyfill.ts` installs — `GodotHttpClient.ts` already
// has its own hand-written UTF-8 decoder for exactly this reason).
// `whatwg-url`'s dependencies need more than just UTF-8, too: `@exodus/bytes`
// (pulled in transitively) eagerly constructs both a `"utf-8"` and a
// `"latin1"` `TextDecoder` at its own module-evaluation time — found
// empirically as `Error: Encoding not supported. Only utf-8 is supported`
// after first trying a UTF-8-only polyfill (`text-encoding-utf-8`), which
// throws in its constructor for any other label rather than only failing if
// that label is ever actually used.
//
// `text-encoding` (not `fast-text-encoding`, which hard-depends on Node's
// `Buffer` global even in its "fallback" path — `r instanceof Buffer` throws
// immediately when `Buffer` doesn't exist) is the WHATWG Encoding Standard's
// reference implementation, supporting the full label set (`"latin1"`
// included, aliased to windows-1252 per spec) rather than just UTF-8. Its
// `module.exports` is the plain `TextEncoder`/`TextDecoder` classes with no
// side effects beyond a harmless attempted self-install (guarded by
// `this || {}` for a strict-mode/ESM context where top-level `this` is
// `undefined`, so it patches a throwaway object rather than `globalThis`) —
// so, same as `abort-controller`/`whatwg-url` in `GodotPolyfill.ts`, the
// actual `globalThis` install is done here explicitly.
import { TextDecoder, TextEncoder } from "text-encoding"

if (typeof (globalThis as { TextEncoder?: unknown }).TextEncoder === "undefined") {
    Object.assign(globalThis, { TextEncoder, TextDecoder })
}
