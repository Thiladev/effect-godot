import "./shared/intl_polyfill"
import { Node } from "godot"

/**
 * Installs the `Intl` polyfill exactly once, for the whole project, before
 * any other script runs.
 *
 * Godot loads `[autoload]` singletons in the order they're listed in
 * `project.godot`, sequentially, before the main scene (and everything else)
 * loads — this autoload must stay first in that list. That ordering is what
 * lets every other script (there could be hundreds) rely on `Intl` existing
 * without importing the polyfill itself.
 */
export default class IntlBootstrap extends Node {}
