// Installs `Intl` onto `globalThis` if missing.
//
// quickjs-ng has no `Intl` implementation at all (confirmed empirically and
// at the engine-source level — see `GodotPolyfill.ts` for the full
// rationale). Without this, anything in `effect`'s `DateTime` module that
// isn't UTC/fixed-offset breaks — `DateTime.format`/`formatLocal`/
// `formatUtc`, and creating any *named* IANA time zone via
// `DateTime.zoneMakeNamed` — since both call `new Intl.DateTimeFormat`
// directly with no service-level indirection to intercept.
//
// Unlike the rest of this directory, each FormatJS package below
// self-detects a native `Intl.*` implementation and no-ops if one already
// exists (see each package's own `should-polyfill.ts`), so there's no
// explicit `globalThis` check to write here.
//
// Only the "en" locale and the common ("golden") time zone subset are
// loaded, to keep bundle size down — this pulled a multi-MB dependency tree
// in practice. If your game ships more locales, or needs the full IANA zone
// list, fork this file rather than editing it in place, since every
// consumer of this package shares it.
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
