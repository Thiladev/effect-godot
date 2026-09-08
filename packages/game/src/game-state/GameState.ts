import { Node } from "godot"
import { events } from "../shared/events"

// Autoload (see project.godot); always constructed before WebView, a child
// of the main scene. Empty for now — game state and its procedure handlers
// were ripped out pending a redo.
export default class GameState extends Node {
    static instance: GameState

    constructor() {
        super()
        GameState.instance = this
        events.on("ready", (name) =>
            console.log(`[GameState] saw "${name}" ready`),
        )
    }

    _ready(): void {
        events.emit("ready", "GameState")
    }
}
