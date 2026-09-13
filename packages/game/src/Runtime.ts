import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai"
import { Config, Layer } from "effect"
import { GodotConfig, GodotConnectionPool, GodotHttpClient, RuntimeNode } from "effect-godot"


/**
 * Talks to an OpenRouter model through Effect's provider-agnostic
 * `LanguageModel` API. OpenRouter is OpenAI-API-compatible, so
 * `@effect/ai-openai`'s client works unchanged against it — only `apiUrl`
 * and the model id differ from talking to OpenAI directly.
 *
 * Reads the key from the `OPENROUTER_API_KEY` environment variable (via
 * `GodotConfig.environmentProvider`, since Godot's JS runtime has no
 * `process.env`) rather than hardcoding it — set it before launching Godot,
 * e.g. `OPENROUTER_API_KEY=sk-or-v1-... godot-bin --project . run`.
 */
const OpenRouterClient = OpenAiClient.layerConfig({
    apiKey: Config.redacted("OPENROUTER_API_KEY"),
    apiUrl: Config.succeed("https://openrouter.ai/api/v1"),
})

export const layer = Layer.empty.pipe(
    Layer.provideMerge(OpenAiLanguageModel.layer({ model: "openai/gpt-4o-mini" })),
    Layer.provideMerge(OpenRouterClient),
    Layer.provideMerge(GodotHttpClient.layer),
    Layer.provideMerge(GodotConnectionPool.layer),
    Layer.provideMerge(GodotConfig.layerAddEnvironment),
    Layer.provideMerge(GodotConfig.layer),
)

export default class Runtime extends RuntimeNode.RuntimeNode(layer) {}
