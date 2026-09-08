import { Camera3D, GDictionary, Input, InputEvent, InputEventMouseButton, InputEventMouseMotion, Key, MouseButton, Node3D, PhysicsRayQueryParameters3D, Variant, Vector3 } from "godot"
import { createClassBinder } from "godot.annotations"


const Godot = createClassBinder()

// The class decorator (@Godot()) is what actually flushes registrations to
// Godot's ClassDB — @Godot.export(...) on its own only stashes into a
// closure-local map inside createClassBinder() and does nothing without it
// (confirmed by reading GodotJS's own source: the class decorator is where
// jsb.internal.add_script_property() is called).
@Godot()
export default class TycoonController extends Node3D {
    @(Godot.export(Variant.Type.TYPE_FLOAT))
    accessor moveSpeed = 2000.0 // world units per second
    @(Godot.export(Variant.Type.TYPE_FLOAT))
    accessor zoomSpeed = 300.0 // world units per wheel notch
    @(Godot.export(Variant.Type.TYPE_FLOAT))
    accessor minDistance = 100.0 // ground limit: closest the camera can zoom in
    @(Godot.export(Variant.Type.TYPE_FLOAT))
    accessor maxDistance = 6000.0 // sky limit: farthest the camera can zoom out, roughly the map's radius
    @(Godot.export(Variant.Type.TYPE_FLOAT))
    accessor initialDistance = 2400.0
    @(Godot.export(Variant.Type.TYPE_FLOAT))
    accessor rayDistance = 20000.0 // long enough to reach the ground from any height/distance in range
    @(Godot.export(Variant.Type.TYPE_FLOAT))
    accessor rotateSensitivity = 0.2 // degrees per pixel of mouse drag
    @(Godot.export(Variant.Type.TYPE_FLOAT))
    accessor minElevationDegrees = 15.0 // shallowest: low, oblique angle
    @(Godot.export(Variant.Type.TYPE_FLOAT))
    accessor maxElevationDegrees = 90.0 // steepest: straight down

    private distance = this.initialDistance
    private elevationDegrees = this.maxElevationDegrees
    private yawDegrees = 0.0
    private camera!: Camera3D

    _ready(): void {
        // This is a mouse-driven, click-to-interact game view (build placement,
        // selection, etc.), not a first-person view that should capture/hide
        // the cursor.
        Input.mouse_mode = Input.MouseMode.MOUSE_MODE_VISIBLE

        this.camera = this.get_node("Camera3D") as Camera3D
        this.updateCameraOffset()

        // Without this, the pivot sits at its scene-file position.y (typically
        // 0, ground level) until the first _physics_process tick corrects it —
        // for even one rendered frame the camera would be offset from ground
        // level rather than from the actual terrain surface.
        this.snapToGround()
    }

    _physics_process(delta: number): void {
        this.move(delta)
        this.snapToGround()
    }

    _unhandled_input(event: InputEvent): void {
        if (event instanceof InputEventMouseButton && event.pressed) {
            if (event.button_index === MouseButton.MOUSE_BUTTON_WHEEL_UP) {
                this.distance = Math.max(this.minDistance, this.distance - this.zoomSpeed)
                this.updateCameraOffset()
            } else if (event.button_index === MouseButton.MOUSE_BUTTON_WHEEL_DOWN) {
                this.distance = Math.min(this.maxDistance, this.distance + this.zoomSpeed)
                this.updateCameraOffset()
            } else if (event.button_index === MouseButton.MOUSE_BUTTON_MIDDLE) {
                this.recenterPivotOnLookTarget()
            }
            return
        }

        if (event instanceof InputEventMouseMotion && Input.is_mouse_button_pressed(MouseButton.MOUSE_BUTTON_MIDDLE)) {
            this.yawDegrees -= event.relative.x * this.rotateSensitivity
            const elevation = this.elevationDegrees - event.relative.y * this.rotateSensitivity
            this.elevationDegrees = Math.min(this.maxElevationDegrees, Math.max(this.minElevationDegrees, elevation))
            this.rotation_degrees = new Vector3(0, this.yawDegrees, 0)
            this.updateCameraOffset()
        }
    }

    private move(delta: number): void {
        let dx = 0 // rightward input
        let dz = 0 // negative is forward, matching Godot's own -Z-forward convention

        if (Input.is_physical_key_pressed(Key.KEY_W)) dz -= 1
        if (Input.is_physical_key_pressed(Key.KEY_S)) dz += 1
        if (Input.is_physical_key_pressed(Key.KEY_A)) dx -= 1
        if (Input.is_physical_key_pressed(Key.KEY_D)) dx += 1

        if (dx === 0 && dz === 0) return

        // Movement is relative to the current yaw, so "forward" always means
        // where the camera is currently looking, not a fixed world axis.
        const yawRadians = (this.yawDegrees * Math.PI) / 180
        const forwardX = -Math.sin(yawRadians)
        const forwardZ = -Math.cos(yawRadians)
        const rightX = Math.cos(yawRadians)
        const rightZ = -Math.sin(yawRadians)

        // Normalise so diagonal movement isn't faster than axis-aligned movement.
        const step = (this.moveSpeed * delta) / Math.hypot(dx, dz)
        const position = this.position
        this.position = new Vector3(position.x + (dx * rightX - dz * forwardX) * step, position.y, position.z + (dx * rightZ - dz * forwardZ) * step)
    }

    /** Positions the child camera at (yaw, elevation, distance) from this pivot. */
    private updateCameraOffset(): void {
        const elevationRadians = (this.elevationDegrees * Math.PI) / 180
        const back = this.distance * Math.cos(elevationRadians)
        const up = this.distance * Math.sin(elevationRadians)
        this.camera.position = new Vector3(0, up, back)
        this.camera.rotation_degrees = new Vector3(-this.elevationDegrees, 0, 0)
    }

    /** Moves the pivot to whatever the camera is currently looking at, so orbiting rotates around that point rather than around the camera. */
    private recenterPivotOnLookTarget(): void {
        const spaceState = this.get_world_3d()?.direct_space_state
        if (!spaceState) return

        const from = this.camera.global_position
        // Godot's forward is -Z; basis.z is the camera's backward direction.
        const backward = this.camera.global_transform.basis.z
        const to = new Vector3(from.x - backward.x * this.rayDistance, from.y - backward.y * this.rayDistance, from.z - backward.z * this.rayDistance)

        const hit: GDictionary = spaceState.intersect_ray(PhysicsRayQueryParameters3D.create(from, to))
        if (hit.is_empty()) return

        const point = hit.get("position") as Vector3
        this.position = new Vector3(point.x, point.y, point.z)
    }

    private snapToGround(): void {
        const spaceState = this.get_world_3d()?.direct_space_state
        const position = this.position
        if (!spaceState) return

        const query = PhysicsRayQueryParameters3D.create(new Vector3(position.x, this.rayDistance, position.z), new Vector3(position.x, -this.rayDistance, position.z))
        const hit: GDictionary = spaceState.intersect_ray(query)
        if (!hit.is_empty()) {
            this.position = new Vector3(position.x, (hit.get("position") as Vector3).y, position.z)
        }
    }
}
