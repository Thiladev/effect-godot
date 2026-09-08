import { Camera3D, CharacterBody3D, Input, InputEvent, InputEventMouseButton, InputEventMouseMotion, Key, MouseButton, Variant, Vector3 } from "godot"
import { createClassBinder } from "godot.annotations"

const Godot = createClassBinder()

/** A simple walk-around FPS rig: WASD to move, mouse to look, space to jump, shift to sprint, right-click to free/recapture the cursor. Drop into any scene via FirstPersonController.tscn. */
@Godot()
export default class FirstPersonController extends CharacterBody3D {
    @(Godot.export(Variant.Type.TYPE_FLOAT))
    accessor moveSpeed = 6.0 // m/s walking speed
    @(Godot.export(Variant.Type.TYPE_FLOAT))
    accessor sprintMultiplier = 1.8 // moveSpeed multiplier while holding Shift
    @(Godot.export(Variant.Type.TYPE_FLOAT))
    accessor jumpVelocity = 4.5 // m/s upward speed applied on jump
    @(Godot.export(Variant.Type.TYPE_FLOAT))
    accessor gravity = 20.0 // m/s^2
    @(Godot.export(Variant.Type.TYPE_FLOAT))
    accessor mouseSensitivity = 0.15 // degrees per pixel of mouse motion
    @(Godot.export(Variant.Type.TYPE_FLOAT))
    accessor minPitchDegrees = -89.0 // looking straight down
    @(Godot.export(Variant.Type.TYPE_FLOAT))
    accessor maxPitchDegrees = 89.0 // looking straight up

    @(Godot.export(Variant.Type.TYPE_FLOAT))
    accessor bobFrequency = 0.15 // stride (side-sway) cycles per metre travelled — ties bob speed to actual walking speed rather than a fixed timer. Vertical bob runs at 2x this, one dip per footstep; at the default moveSpeed that's ~1.8 vertical bobs/second, roughly real walking cadence
    @(Godot.export(Variant.Type.TYPE_FLOAT))
    accessor bobVerticalAmplitude = 0.05 // metres
    @(Godot.export(Variant.Type.TYPE_FLOAT))
    accessor bobSideAmplitude = 0.025 // metres
    @(Godot.export(Variant.Type.TYPE_FLOAT))
    accessor bobFadeSpeed = 8.0 // how fast the bob eases in/out when starting/stopping, per second

    private camera!: Camera3D
    private cameraRestPosition!: Vector3
    private pitchDegrees = 0.0
    private bobPhaseRadians = 0.0
    private bobAmount = 0.0 // eased 0..1, so bob fades in/out instead of snapping

    _ready(): void {
        this.camera = this.get_node("Camera3D") as Camera3D
        this.cameraRestPosition = this.camera.position
        Input.mouse_mode = Input.MouseMode.MOUSE_MODE_CAPTURED
    }

    _unhandled_input(event: InputEvent): void {
        if (event instanceof InputEventMouseButton && event.pressed && event.button_index === MouseButton.MOUSE_BUTTON_RIGHT) {
            // Right-click frees the cursor (e.g. to click something else on
            // screen) without leaving first-person mode entirely; right-click
            // again to recapture it and resume looking around.
            Input.mouse_mode = Input.mouse_mode === Input.MouseMode.MOUSE_MODE_CAPTURED ? Input.MouseMode.MOUSE_MODE_VISIBLE : Input.MouseMode.MOUSE_MODE_CAPTURED
            return
        }

        if (!(event instanceof InputEventMouseMotion)) return
        if (Input.mouse_mode !== Input.MouseMode.MOUSE_MODE_CAPTURED) return

        this.rotation_degrees = new Vector3(0, this.rotation_degrees.y - event.relative.x * this.mouseSensitivity, 0)
        this.pitchDegrees = Math.min(this.maxPitchDegrees, Math.max(this.minPitchDegrees, this.pitchDegrees - event.relative.y * this.mouseSensitivity))
        this.camera.rotation_degrees = new Vector3(this.pitchDegrees, 0, 0)
    }

    _physics_process(delta: number): void {
        let velocity = this.velocity
        if (!this.is_on_floor()) {
            velocity = new Vector3(velocity.x, velocity.y - this.gravity * delta, velocity.z)
        } else if (Input.is_physical_key_pressed(Key.KEY_SPACE)) {
            velocity = new Vector3(velocity.x, this.jumpVelocity, velocity.z)
        }

        let dx = 0 // rightward input
        let dz = 0 // negative is forward, matching Godot's own -Z-forward convention
        if (Input.is_physical_key_pressed(Key.KEY_W)) dz -= 1
        if (Input.is_physical_key_pressed(Key.KEY_S)) dz += 1
        if (Input.is_physical_key_pressed(Key.KEY_A)) dx -= 1
        if (Input.is_physical_key_pressed(Key.KEY_D)) dx += 1

        const moving = dx !== 0 || dz !== 0
        if (moving) {
            // Movement is relative to the current yaw, so "forward" always
            // means where the player is currently looking.
            const yawRadians = (this.rotation_degrees.y * Math.PI) / 180
            const forwardX = -Math.sin(yawRadians)
            const forwardZ = -Math.cos(yawRadians)
            const rightX = Math.cos(yawRadians)
            const rightZ = -Math.sin(yawRadians)

            const sprinting = Input.is_physical_key_pressed(Key.KEY_SHIFT)
            const speed = this.moveSpeed * (sprinting ? this.sprintMultiplier : 1)

            // Normalise so diagonal movement isn't faster than axis-aligned movement.
            const inverse = 1 / Math.hypot(dx, dz)
            const moveX = (dx * rightX - dz * forwardX) * inverse
            const moveZ = (dx * rightZ - dz * forwardZ) * inverse
            velocity = new Vector3(moveX * speed, velocity.y, moveZ * speed)
        } else {
            velocity = new Vector3(0, velocity.y, 0)
        }

        this.velocity = velocity
        this.move_and_slide()

        this.updateViewBob(delta, moving && this.is_on_floor())
    }

    /** Advances the bob cycle by distance actually travelled (so it speeds up with sprint automatically) and eases the bob amount in/out so starting or stopping walking doesn't snap the camera. */
    private updateViewBob(delta: number, bobbing: boolean): void {
        const horizontalSpeed = Math.hypot(this.velocity.x, this.velocity.z)
        this.bobPhaseRadians += horizontalSpeed * this.bobFrequency * delta * (2 * Math.PI)

        const targetBobAmount = bobbing ? 1 : 0
        const bobStep = this.bobFadeSpeed * delta
        this.bobAmount += Math.min(bobStep, Math.max(-bobStep, targetBobAmount - this.bobAmount))

        // Double frequency vertically (one bob per footstep, not per stride) and
        // half-offset horizontally, so the motion traces a figure-8 like a real
        // head bob rather than a straight up-down bounce.
        const bobY = Math.sin(this.bobPhaseRadians * 2) * this.bobVerticalAmplitude * this.bobAmount
        const bobX = Math.sin(this.bobPhaseRadians) * this.bobSideAmplitude * this.bobAmount
        this.camera.position = new Vector3(this.cameraRestPosition.x + bobX, this.cameraRestPosition.y + bobY, this.cameraRestPosition.z)
    }
}
