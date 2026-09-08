import { Button, Callable, CanvasLayer, CharacterBody3D, GDictionary, InputEvent, InputEventKey, Key, Node3D, PackedScene, PhysicsRayQueryParameters3D, ResourceLoader, Vector3 } from "godot"
import type FirstPersonController from "../controller/FirstPersonController"
import type TycoonController from "../controller/TycoonController"

const TYCOON_CONTROLLER_SCENE = "res://src/controller/TycoonController.tscn"
const FIRST_PERSON_CONTROLLER_SCENE = "res://src/controller/FirstPersonController.tscn"
const RAY_DISTANCE = 20000.0 // long enough to reach the ground from any height in range

/**
 * A button (plus a Tab shortcut) that swaps a sibling TycoonController for a
 * FirstPersonController, or back — only one of the two ever exists in the
 * scene at a time, rather than both coexisting with an "active" flag. Drop
 * into a scene as a sibling of whichever controller starts present.
 *
 * The Tab shortcut isn't just a convenience: FirstPersonController captures
 * the mouse for look control, and a captured cursor can't reliably click a
 * fixed-position button (the click just becomes a huge relative mouse-look
 * motion instead) — Tab is the only way back once in first-person mode.
 */
export default class CameraSwitchUI extends CanvasLayer {
    private button!: Button
    private current!: TycoonController | FirstPersonController // whichever controller is currently spawned

    _ready(): void {
        this.button = this.get_node("Button") as Button
        this.button.pressed.connect(Callable.create(() => this.toggle()))

        this.current = (this.get_parent() as Node3D).get_node("TycoonController") as unknown as TycoonController
        this.updateLabel()
    }

    _unhandled_input(event: InputEvent): void {
        if (event instanceof InputEventKey && event.pressed && event.keycode === Key.KEY_TAB) {
            this.toggle()
        }
    }

    private toggle(): void {
        const parent = this.get_parent() as Node3D
        const switchingToFirstPerson = !(this.current instanceof CharacterBody3D)

        // Where the new controller should appear: the tycoon rig's own
        // position is its ground pivot (the camera itself sits elsewhere,
        // offset by distance/elevation), so its Camera3D child is the point
        // that actually represents "where the view is"; the FPS rig's own
        // position already is that point.
        const spawnFrom = switchingToFirstPerson ? (this.current.get_node("Camera3D") as Node3D).global_position : this.current.global_position

        parent.remove_child(this.current)
        this.current.queue_free()

        const instance = switchingToFirstPerson
            ? (ResourceLoader.load(FIRST_PERSON_CONTROLLER_SCENE) as PackedScene<FirstPersonController>).instantiate()
            : (ResourceLoader.load(TYCOON_CONTROLLER_SCENE) as PackedScene<TycoonController>).instantiate()
        instance.set_name(switchingToFirstPerson ? "FirstPersonController" : "TycoonController")

        // TycoonController snaps its own pivot to the ground every physics
        // frame, so handing it any position at the right X/Z is enough —
        // but FirstPersonController only reacts to gravity from its next
        // physics frame onward, which would mean falling the entire height
        // the tycoon camera was orbiting from. Raycast it onto the ground
        // immediately instead.
        instance.position = switchingToFirstPerson ? this.groundBelow(spawnFrom) : spawnFrom

        parent.add_child(instance)
        this.current = instance
        this.updateLabel()
    }

    private groundBelow(from: Vector3): Vector3 {
        const spaceState = (this.get_parent() as Node3D).get_world_3d()?.direct_space_state
        if (!spaceState) return from

        const query = PhysicsRayQueryParameters3D.create(new Vector3(from.x, from.y + RAY_DISTANCE, from.z), new Vector3(from.x, from.y - RAY_DISTANCE, from.z))
        const hit: GDictionary = spaceState.intersect_ray(query)
        if (hit.is_empty()) return from

        return hit.get("position") as Vector3
    }

    private updateLabel(): void {
        const firstPerson = this.current instanceof CharacterBody3D
        this.button.text = firstPerson ? "Switch to Tycoon Camera (Tab)" : "Switch to First Person (Tab)"
    }
}
