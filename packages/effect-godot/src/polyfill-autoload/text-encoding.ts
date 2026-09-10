// Installs `TextEncoder`/`TextDecoder` onto `globalThis` if missing.
//
// This is its own module — not inline code inside `polyfill-autoload/index.ts` — and
// must be imported there *before* `./url`. ES module `import` declarations
// are hoisted and their whole dependency graph evaluated as a group, before
// any of the importing file's own top-level code runs, regardless of where
// that code sits relative to the imports. So plain statements installing
// this between two `import` lines would still run *after* `./url`'s import
// (and its transitive `TextEncoder` dependency) has already been evaluated —
// confirmed the hard way: `whatwg-url`'s IDNA/host processing needs
// `TextEncoder` at `./url`'s own module-evaluation time, not just when
// something later calls it, and inlining this didn't fix that.
// Only another `import`, positioned earlier, actually guarantees the
// ordering — which is why this is a separate module in the first place.
//
// quickjs-ng has no TextEncoder/TextDecoder either (the same story as
// everything else this directory installs). `./url`'s dependencies need
// more than just UTF-8, too: `@exodus/bytes`
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
// so, same as the rest of this directory, the actual `globalThis` install is
// done here explicitly.
import { TextDecoder, TextEncoder } from "text-encoding"

if (typeof (globalThis as { TextEncoder?: unknown }).TextEncoder === "undefined") {
    Object.assign(globalThis, { TextEncoder, TextDecoder })
}
