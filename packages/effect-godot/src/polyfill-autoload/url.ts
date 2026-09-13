// quickjs-ng has no URL implementation, and Effect resolves HTTP request URLs
// through the global URL constructor. whatwg-url does not install itself on
// globalThis, so install its implementations explicitly.
// This module is imported after text-encoding because whatwg-url may need it
// while its dependency graph is being evaluated.
import { URL, URLSearchParams } from "whatwg-url"

if (typeof (globalThis as { URL?: unknown }).URL === "undefined") {
    Object.assign(globalThis, { URL, URLSearchParams })
}
