import { CompressedTexture2D, DirAccess, GArray, Image, Node3D, ProjectSettings, ResourceLoader, ResourceSaver, Terrain3D, Terrain3DData, Terrain3DTextureAsset, Terrain3DUtil, TerrainGenerator, Vector3 } from "godot"

// Dev tool, not part of the game: generates a terrain (same generator and
// parameters as TerrainGenTest) with a fixed seed and bakes it to real
// Terrain3D region/resource files on disk, so TerrainGenTestStatic.tscn can
// use a plain, script-free Terrain3D node — instant to open in the editor,
// no regeneration on every scene load. Re-run this (via `bun run edit`, open
// Bake.tscn, run it) whenever the baked map itself needs to change; the
// static scene never needs touching.

const SEED = 12345 // fixed, so re-baking reproduces the same map

const MAP_DIAMETER_METERS = 10_240
const CELL_SIZE_METERS = 10
const PEAK_HEIGHT_METERS = 1200

const CELLS = Math.round(MAP_DIAMETER_METERS / CELL_SIZE_METERS)
const VERTEX_SPACING = CELL_SIZE_METERS
const HEIGHT_SCALE = PEAK_HEIGHT_METERS

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

const OUTPUT_DIR = "res://src/maps/TerrainGenTestStatic/terrain"
const DATA_DIR = `${OUTPUT_DIR}/data`
// .res (binary), not .tres (text): Terrain3DAssets auto-generates a
// placeholder normal map per texture, and saving that as text writes its raw
// pixel data out as verbose ASCII-decimal (a ~16MB texture bloats to
// hundreds of MB) — confirmed the hard way, it also made the scene hang on
// load trying to parse it.
const ASSETS_PATH = `${OUTPUT_DIR}/assets.res`
const MATERIAL_PATH = `${OUTPUT_DIR}/material.res`

export default class Bake extends Node3D {
    _ready(): void {
        DirAccess.make_dir_recursive_absolute(ProjectSettings.globalize_path(DATA_DIR))

        const generator = new TerrainGenerator()
        generator.set_size(CELLS, CELLS)
        generator.set_seed(SEED)

        if (!generator.generate()) {
            console.error(`[Bake] generation failed: ${generator.get_last_error()}`)
            return
        }

        const heightmap = generator.get_heightmap_image()
        if (!heightmap) {
            console.error("[Bake] generate() succeeded but produced no heightmap image")
            return
        }

        const terrain = new Terrain3D()
        terrain.vertex_spacing = VERTEX_SPACING
        terrain.data_directory = DATA_DIR
        this.add_child(terrain)

        const assets = terrain.assets
        if (assets) {
            const textureList = new GArray<Terrain3DTextureAsset>()
            textureList.push_back(createTextureAsset(ROCK_TEXTURE_ID, ROCK_TEXTURE_PATH))
            textureList.push_back(createTextureAsset(SNOW_TEXTURE_ID, SNOW_TEXTURE_PATH))
            assets.texture_list = textureList
            ResourceSaver.save(assets, ASSETS_PATH)
        }
        if (terrain.material) {
            terrain.material.auto_shader = true
            ResourceSaver.save(terrain.material, MATERIAL_PATH)
        }

        const controlValue = Terrain3DUtil.enc_base(ROCK_TEXTURE_ID) | Terrain3DUtil.enc_overlay(SNOW_TEXTURE_ID) | Terrain3DUtil.enc_auto(true)
        const control = createUniformImage(CELLS, CELLS, controlValue, FORMAT_RF)

        const images = new GArray<Image | null>()
        images.push_back(heightmap)
        images.push_back(control)
        images.push_back(null)

        const data = terrain.data as unknown as Terrain3DData
        const halfExtent = (CELLS * VERTEX_SPACING) / 2
        const origin = new Vector3(-halfExtent, 0, -halfExtent)
        data.import_images(images as unknown as GArray<Image>, origin, 0, HEIGHT_SCALE)
        data.update_maps()
        data.save_directory(DATA_DIR)

        console.log(`[Bake] baked a ${generator.get_width()}x${generator.get_height()} map (seed ${SEED}) to ${DATA_DIR}`)
    }
}

function createTextureAsset(id: number, path: string): Terrain3DTextureAsset {
    const asset = new Terrain3DTextureAsset()
    asset.id = id
    asset.albedo_texture = ResourceLoader.load(path) as CompressedTexture2D
    return asset
}

/** Builds an Image where every pixel's raw bytes equal `value` (little-endian), for formats like FORMAT_RF where the bit pattern is meaningful data rather than a numeric colour. */
function createUniformImage(width: number, height: number, value: number, format: number): Image {
    const buffer = new ArrayBuffer(width * height * 4)
    const view = new DataView(buffer)
    for (let i = 0; i < width * height; i++) {
        view.setUint32(i * 4, value >>> 0, true)
    }
    return Image.create_from_data(width, height, false, format, buffer)
}
