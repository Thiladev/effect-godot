import { Node3D, Terrain3D } from "godot"

/** Static counterpart to TerrainGenTest: the map itself is pre-baked (see Bake.ts) instead of generated on load, so all this does is hand Terrain3D the camera it needs to track — Terrain3D would pick it up on its own a frame later anyway, this just avoids that one-frame gap. */
export default class TerrainGenTestStatic extends Node3D {
    _ready(): void {
        const terrain = this.get_node("Terrain3D") as Terrain3D
        const camera = this.get_viewport()?.get_camera_3d()
        if (camera) {
            terrain.set_camera(camera)
        } else {
            console.error("[TerrainGenTestStatic] no active Camera3D found; terrain will not render")
        }
    }
}
