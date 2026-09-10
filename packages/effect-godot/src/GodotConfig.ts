import { ConfigProvider, Effect, Layer } from "effect"
import { OS, ProjectSettings } from "godot"


/**
 * A `ConfigProvider` reading Godot `ProjectSettings` — `project.godot` plus
 * any `override.cfg`. A `Config`'s path segments join with `/`, matching
 * `ProjectSettings`' own key convention (e.g. `Config.string("application/config/name")`).
 *
 * Reads through `get_setting_with_override`, so per-feature-tag overrides
 * (`.editor`, `.windows`, ...) apply automatically. Godot's own convention
 * for "unset" is a `null` value (that's how `set_setting` erases a key), so
 * `null` here is treated as absent rather than a literal value.
 */
export const configProvider: ConfigProvider.ConfigProvider = ConfigProvider.make((path) =>
    Effect.sync(() => {
        const value = ProjectSettings.get_setting_with_override(path.join("/"))
        return value === null ? undefined : ConfigProvider.makeValue(String(value))
    }),
)

/**
 * A `ConfigProvider` reading real OS environment variables through `OS`. A
 * `Config`'s path segments join with `_`, matching `effect`'s own `fromEnv`
 * convention. `OS` has no way to enumerate environment variables, so unlike
 * `fromEnv` this only supports direct lookups — no `Config.Struct`-style
 * child discovery.
 *
 * `OS.get_environment` is a no-op returning nothing on sandboxed export
 * targets (e.g. web), where `configProvider` above always works — prefer
 * {@link layerAddEnvironment} (environment as an override, `ProjectSettings`
 * as the fallback) over using this alone.
 */
export const environmentProvider: ConfigProvider.ConfigProvider = ConfigProvider.make((path) =>
    Effect.sync(() => {
        const name = path.join("_")
        return OS.has_environment(name) ? ConfigProvider.makeValue(OS.get_environment(name)) : undefined
    }),
)

/** Replaces the active `ConfigProvider` with {@link configProvider}. */
export const layer: Layer.Layer<never> = ConfigProvider.layer(configProvider)

/**
 * Adds {@link configProvider} as a fallback to the currently active
 * `ConfigProvider`, consulted only when the current one has no value for a
 * path.
 */
export const layerAdd: Layer.Layer<never> = ConfigProvider.layerAdd(configProvider)

/**
 * Adds {@link environmentProvider} as the primary `ConfigProvider`, falling
 * back to whatever was already active when *this* layer is built — so an
 * environment variable, when set, overrides the same key read from
 * `ProjectSettings`. That "already active" provider has to be built first
 * and fed in as this layer's dependency, e.g.:
 *
 * ```ts
 * Layer.provide(GodotConfig.layerAddEnvironment, GodotConfig.layer)
 * ```
 *
 * (backwards — `Layer.provide(GodotConfig.layer, GodotConfig.layerAddEnvironment)`
 * — builds `GodotConfig.layer` from a plain `Layer.succeed`, which ignores
 * the environment layer entirely and always wins.)
 */
export const layerAddEnvironment: Layer.Layer<never> = ConfigProvider.layerAdd(environmentProvider, {
    asPrimary: true,
})
