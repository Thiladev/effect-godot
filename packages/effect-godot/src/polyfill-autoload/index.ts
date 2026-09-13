import { Node } from "godot"

import "./abort-controller.js"
// text-encoding must be evaluated before url.
import "./text-encoding.js"
import "./url.js"
import "./intl.js"


/** Installs the Web APIs used by Effect. Add this as the first JavaScript autoload. */
export default class GodotPolyfill extends Node {}
