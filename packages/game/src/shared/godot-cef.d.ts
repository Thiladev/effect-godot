// Ambient types for the godot-cef addon's `CefTexture` class.
//
// `bun run typegen` drives GodotJS's `--generate-types`, which walks
// ClassDB to produce `typings/godot*.gen.d.ts` — but in headless/software
// environments (no RenderingDevice) that snapshot is taken before
// godot-cef finishes its Scene-level class registration, so `CefTexture`
// ends up missing from the generated output even though it's genuinely
// registered and instantiable at runtime (verified by actually running a
// scene with a CefTexture node). This fills that gap; delete it if a
// future `typegen` run picks the class up on its own.
import "godot"

declare module "godot" {
    class CefTexture extends TextureRect {
        url: string
        enable_accelerated_osr: boolean
        eval(code: string): void
    }
}
