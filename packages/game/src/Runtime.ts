import { OpenRouterClient, OpenRouterLanguageModel } from "@effect/ai-openrouter"
import { Config, Layer } from "effect"
import { GodotConfig, GodotConnectionPool, GodotHttpClient, RuntimeNode } from "effect-godot"


/**
 * Talks to an OpenRouter model through Effect's provider-agnostic
 * `LanguageModel` API, via `@effect/ai-openrouter` — the purpose-built
 * OpenRouter provider (rather than pointing `@effect/ai-openai` at
 * OpenRouter's base URL), since it correctly stops at OpenRouter's trailing
 * `data: [DONE]` SSE sentinel instead of trying to JSON-decode it.
 *
 * Reads the key from the `OPENROUTER_API_KEY` environment variable (via
 * `GodotConfig.environmentProvider`, since Godot's JS runtime has no
 * `process.env`) rather than hardcoding it — set it before launching Godot,
 * e.g. `OPENROUTER_API_KEY=sk-or-v1-... godot-bin --project . run`.
 */
const OpenRouter = OpenRouterClient.layerConfig({
    apiKey: Config.Redacted("OPENROUTER_API_KEY"),
})

export const layer = Layer.empty.pipe(
    Layer.provideMerge(OpenRouterLanguageModel.layer({ model: "openai/gpt-4o-mini" })),
    Layer.provideMerge(OpenRouter),
    Layer.provideMerge(GodotHttpClient.layer),
    Layer.provideMerge(GodotConnectionPool.layer),
    Layer.provideMerge(GodotConfig.layerAddEnvironment),
    Layer.provideMerge(GodotConfig.layer),
)

export default class Runtime extends RuntimeNode.RuntimeNode(layer) {}
