// Install the Intl APIs needed by Effect's DateTime utilities. FormatJS
// detects native implementations and skips its polyfills when available.
// Keep the bundle small by including only English data and golden time zones.
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
