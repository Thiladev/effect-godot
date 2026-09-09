import { Node } from "godot"

/**
 * Ordinary scene-tree node script (not an autoload) attached to a child of
 * `Main.tscn`, loaded through the normal scene-instantiation path rather
 * than the `[autoload]` singleton mechanism `IntlBootstrap`/`EffectProbe`
 * use. Checks that `Intl` (installed by the `IntlBootstrap` autoload, which
 * loads earlier) is visible here too — i.e. that it's genuinely one shared
 * JS global, not something scoped to the autoload chain.
 */
export default class IntlConsumerProbe extends Node {
    _ready() {
        if (typeof Intl === "undefined") {
            console.log("[IntlConsumerProbe] FAIL: Intl is not defined here")
            return
        }
        const formatted = new Intl.DateTimeFormat("en-US", {
            year: "numeric",
            month: "long",
            day: "numeric",
            timeZone: "UTC",
        }).format(new Date("2024-06-15T14:30:00.000Z"))
        console.log(`[IntlConsumerProbe] PASS: Intl visible from an ordinary scene node, formatted: ${formatted}`)
    }
}
