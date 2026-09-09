/**
 * GodotJS's quickjs-ng build ships with no `Intl` global at all (confirmed by
 * running `EffectProbe`: `ReferenceError: Intl is not defined`), which
 * breaks anything in `effect`'s `DateTime` module that isn't UTC/fixed-offset
 * (`DateTime.format`/`formatLocal`/`formatUtc`, and creating any *named* IANA
 * time zone via `DateTime.zoneMakeNamed`, both call `new Intl.DateTimeFormat`
 * directly with no service-level indirection to intercept).
 *
 * This installs FormatJS's spec-conformant polyfill for the pieces `effect`
 * actually needs. Each polyfill self-detects a native implementation and
 * no-ops if one exists, so this is safe to import unconditionally across
 * export targets (desktop/editor here has no `Intl` either, but Web exports
 * might).
 *
 * Import this before anything that touches `DateTime` formatting or named
 * zones runs — ideally as the first import in every entrypoint, since none
 * of this has side effects beyond installing `globalThis.Intl.*`.
 *
 * Only the "en" locale and the common ("golden") time zone subset are loaded
 * to keep bundle size down; add more `locale-data`/`add-all-tz` imports here
 * if the game ships more locales or needs the full IANA zone list.
 */
import "@formatjs/intl-getcanonicallocales/polyfill.js"
import "@formatjs/intl-locale/polyfill.js"
// `@formatjs/intl-numberformat`'s own internals unconditionally reference
// `Intl.PluralRules` and `Intl.ListFormat` (for compact-notation/unit
// formatting plural selection), even when the options in use don't need
// either — found empirically as a `TypeError: not a function` deep inside
// `NumberFormat` until these two were added.
import "@formatjs/intl-pluralrules/polyfill.js"
import "@formatjs/intl-pluralrules/locale-data/en.js"
import "@formatjs/intl-listformat/polyfill.js"
import "@formatjs/intl-listformat/locale-data/en.js"
import "@formatjs/intl-numberformat/polyfill.js"
import "@formatjs/intl-numberformat/locale-data/en.js"
import "@formatjs/intl-datetimeformat/polyfill.js"
import "@formatjs/intl-datetimeformat/locale-data/en.js"
import "@formatjs/intl-datetimeformat/add-golden-tz.js"
