import { CompressedTexture2D, GArray, Image, Node3D, randi, ResourceLoader, Terrain3D, Terrain3DData, Terrain3DTextureAsset, Terrain3DUtil, TerrainGenerator, Vector3 } from "godot"

// Human-friendly generation parameters — everything below this block is
// derived from these three, so tune the mountain by editing these directly
// rather than CELLS/VERTEX_SPACING/HEIGHT_SCALE.
const MAP_DIAMETER_METERS = 10_240 // edge-to-edge real-world size of the generated map
const CELL_SIZE_METERS = 10 // resolution: world units per heightmap cell (Terrain3D's vertex_spacing)
const PEAK_HEIGHT_METERS = 1200 // vertical drop from sea level to the generator's highest point

const CELLS = Math.round(MAP_DIAMETER_METERS / CELL_SIZE_METERS)
const VERTEX_SPACING = CELL_SIZE_METERS
const HEIGHT_SCALE = PEAK_HEIGHT_METERS

// Slope gradient is height ÷ horizontal distance, not anything the generator
// controls directly — a tall PEAK_HEIGHT_METERS needs a wide MAP_DIAMETER_METERS
// to match, or the "mountain" is just a near-vertical wall. Logged rather than
// hand-computed so changing either input makes its effect on steepness visible.
const AVERAGE_GRADE_PERCENT = Math.round((PEAK_HEIGHT_METERS / (MAP_DIAMETER_METERS / 2)) * 100)

// CC0 photo textures from Poly Haven (see textures/SOURCE.txt) — Terrain3D
// blends between these two slots by slope via auto_shader, rather than the
// terrain needing to be manually painted.
const ROCK_TEXTURE_ID = 0
const ROCK_TEXTURE_PATH = "res://src/maps/TerrainGenTest/textures/rock_diffuse.jpg"
const SNOW_TEXTURE_ID = 1
const SNOW_TEXTURE_PATH = "res://src/maps/TerrainGenTest/textures/snow_diffuse.jpg"

// Image.Format.FORMAT_RF — see godot/core/io/image.h. Read directly as an
// integer rather than through the enum namespace: nested enum namespaces on
// non-singleton classes aren't reliably bridged to JS at runtime in this
// GodotJS binding (confirmed the hard way elsewhere in this project), while
// the plain class itself and its static methods are.
const FORMAT_RF = 8

export default class TerrainGenTest extends Node3D {
    _ready(): void {
        const seed = randi()

        const generator = new TerrainGenerator()
        generator.set_size(CELLS, CELLS)
        generator.set_seed(seed)

        if (!generator.generate()) {
            console.error(
                `[TerrainGenTest] generation failed: ${generator.get_last_error()}`,
            )
            return
        }

        const heightmap = generator.get_heightmap_image()
        if (!heightmap) {
            console.error(
                "[TerrainGenTest] generate() succeeded but produced no heightmap image",
            )
            return
        }

        const terrain = new Terrain3D()
        terrain.vertex_spacing = VERTEX_SPACING
        this.add_child(terrain)

        // Two texture "slots" (rock for steep slopes, snow for flat ground)
        // that Terrain3DMaterial.auto_shader blends between automatically based
        // on slope, instead of needing the terrain to be manually painted.
        const assets = terrain.assets
        if (assets) {
            const textureList = new GArray<Terrain3DTextureAsset>()
            textureList.push_back(createTextureAsset(ROCK_TEXTURE_ID, ROCK_TEXTURE_PATH))
            textureList.push_back(createTextureAsset(SNOW_TEXTURE_ID, SNOW_TEXTURE_PATH))
            assets.texture_list = textureList
        }
        if (terrain.material) {
            terrain.material.auto_shader = true
        }

        // Terrain3DData.import_images wants a MapType.TYPE_MAX-sized array
        // (Height, Control, Color); Color is optional and can be null. The
        // control layer assigns base/overlay texture IDs and enables auto-shading
        // per pixel — built once in bulk here rather than via thousands of
        // individual Terrain3DData.set_control_*() calls.
        const controlValue =
            Terrain3DUtil.enc_base(ROCK_TEXTURE_ID) |
            Terrain3DUtil.enc_overlay(SNOW_TEXTURE_ID) |
            Terrain3DUtil.enc_auto(true)
        const control = createUniformImage(
            CELLS,
            CELLS,
            controlValue,
            FORMAT_RF,
        )

        const images = new GArray<Image | null>()
        images.push_back(heightmap)
        images.push_back(control)
        images.push_back(null)

        const data = terrain.data as unknown as Terrain3DData
        // Centre the map on the world origin (rather than anchoring its corner
        // there) so "the middle of the map" and "world (0, 0, 0)" are the same
        // point — no magic number elsewhere needs to know the map's size to find
        // its centre.
        const halfExtent = (CELLS * VERTEX_SPACING) / 2
        const origin = new Vector3(-halfExtent, 0, -halfExtent)
        // import_images's binding is typed as GArray<Image>, but Control/Color
        // entries are documented as nullable ("Images can be blank or null").
        data.import_images(
            images as unknown as GArray<Image>,
            origin,
            0,
            HEIGHT_SCALE,
        )

        // Terrain3D only builds/updates the chunks it draws around whichever
        // camera it's snapping to; it can auto-detect the viewport's current
        // camera, but that only happens on a later frame, so set it explicitly
        // now rather than relying on timing.
        const camera = this.get_viewport()?.get_camera_3d()
        if (camera) {
            terrain.set_camera(camera)
        } else {
            console.error(
                "[TerrainGenTest] no active Camera3D found; terrain will not render",
            )
        }

        console.log(
            `[TerrainGenTest] imported a ${generator.get_width()}x${generator.get_height()} generated map (seed ${seed}, ${MAP_DIAMETER_METERS}m diameter, ${PEAK_HEIGHT_METERS}m peak, ~${AVERAGE_GRADE_PERCENT}% average grade) into Terrain3D`,
        )
    }
}

function createTextureAsset(id: number, path: string): Terrain3DTextureAsset {
    const asset = new Terrain3DTextureAsset()
    asset.id = id
    asset.albedo_texture = ResourceLoader.load(path) as CompressedTexture2D
    return asset
}

/** Builds an Image where every pixel's raw bytes equal `value` (little-endian), for formats like FORMAT_RF where the bit pattern is meaningful data rather than a numeric colour. */
function createUniformImage(
    width: number,
    height: number,
    value: number,
    format: number,
): Image {
    const buffer = new ArrayBuffer(width * height * 4)
    const view = new DataView(buffer)
    for (let i = 0; i < width * height; i++) {
        view.setUint32(i * 4, value >>> 0, true)
    }
    return Image.create_from_data(width, height, false, format, buffer)
}
