// quickjs-ng has no AbortController. Effect's HTTP client creates one for
// every request, so install it before any HTTP client is used.
// Import the implementation directly: the package's auto-install entrypoint
// checks browser globals that GodotJS does not define.
import { AbortController, AbortSignal } from "abort-controller/dist/abort-controller.js"

if (typeof (globalThis as { AbortController?: unknown }).AbortController === "undefined") {
    Object.assign(globalThis, { AbortController, AbortSignal })
}
