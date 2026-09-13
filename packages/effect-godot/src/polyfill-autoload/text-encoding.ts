// Keep this in a separate module and evaluate it before url.ts: dependencies
// of whatwg-url may construct a TextDecoder during module evaluation.
// `text-encoding` supports the labels those dependencies require and does not
// depend on Node's Buffer global.
import { TextDecoder, TextEncoder } from "text-encoding"

if (typeof (globalThis as { TextEncoder?: unknown }).TextEncoder === "undefined") {
    Object.assign(globalThis, { TextEncoder, TextDecoder })
}
