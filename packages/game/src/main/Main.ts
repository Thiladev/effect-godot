import { Node2D } from "godot"
import { events } from "../shared/events"

export default class Main extends Node2D {
    _ready(): void {
        events.emit("ready", "Main")
    }
}
