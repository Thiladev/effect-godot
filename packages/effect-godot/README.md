# effect-godot

(Very) experimental Effect bindings for [GodotJS](https://github.com/godotjs/GodotJS), a QuickJS/V8-based JavaScript runtime for Godot.

## Quick setup

Install `effect` and `effect-godot`, then bundle your TypeScript scripts to CommonJS before Godot loads them. GodotJS loads CommonJS scripts and provides the `godot` module at runtime; `effect` itself is ESM-only, so use a bundler such as Rolldown or esbuild rather than plain `tsc`.

GodotJS also needs polyfills. Add this as the first JavaScript autoload:

```ts
// src/GodotPolyfill.ts
export { default } from "effect-godot/polyfill-autoload"
```

```ini
[autoload]
GodotPolyfill="*res://src/GodotPolyfill.ts"
```

The bundled output must be available under the paths referenced by your Godot scenes. A minimal bundler configuration should use `format: "cjs"` and keep `godot` external.

## RuntimeNode

`RuntimeNode(layer)` creates a Godot `Node` that owns an Effect `ManagedRuntime`. The layer is built when the node enters the scene tree, and disposed when it exits. Disposing the node's runtime interrupts its forked fibers and releases resources owned by the layer.

Define one runtime class for the services a scene needs:

```ts
// src/GameRuntime.ts
import { Context, Effect, Layer } from "effect"
import { RuntimeNode } from "effect-godot"

export class Greeter extends Context.Service<
  Greeter,
  { readonly greet: (name: string) => Effect.Effect<string> }
>()("game/Greeter") {}

const layer = Layer.succeed(Greeter, {
  greet: (name) => Effect.succeed(`Hello, ${name}!`),
})

export default class GameRuntime extends RuntimeNode.RuntimeNode(layer) {}
```

Attach `GameRuntime` to a node in the scene. The runtime node should be an ancestor of nodes that use its services:

```text
GameRuntime (Node, GameRuntime.ts)
└── GreeterLabel (Label, GreeterLabel.ts)
```

## EffectfulNode

To use Effect within ordinary Godot nodes, use the runtime class's `EffectfulNode` trait. It preserves the base node class and adds:

- `runtime_node`: the `RuntimeNode` found in the scene tree.
- `runSync(effect)`: runs an Effect synchronously with the runtime's services.
- `runPromise(effect, options?)`: runs an Effect as a promise.
- `runFork(effect, options?)`: forks an Effect using the runtime.

```ts
// src/GreeterLabel.ts
import { Effect } from "effect"
import { Label } from "godot"
import GameRuntime, { Greeter } from "./GameRuntime.js"

export default class GreeterLabel extends GameRuntime.EffectfulNode(Label) {
  async _ready(): Promise<void> {
    await this.runPromise(
      Greeter.use((greeter) => greeter.greet("Godot")).pipe(
        Effect.tap((message) => Effect.sync(() => { this.text = message })),
      ),
    )
  }
}
```

The trait looks up the matching runtime by an internal, unique scene-tree group. A node must be in the tree after its corresponding runtime node has entered it; making the runtime an ancestor is the simplest arrangement.

## Modules

### `GodotConfig`

Provides Effect's `ConfigProvider` from Godot `ProjectSettings`:

```ts
import { Config, Effect } from "effect"
import { GodotConfig } from "effect-godot"

const projectName = Config.string("application/config/name").pipe(
  Effect.provide(GodotConfig.layer),
)
```

Use `GodotConfig.layerAdd` to use `ProjectSettings` as a fallback. `layerAddEnvironment` puts OS environment variables first and falls back to the existing provider:

```ts
import { Layer } from "effect"
import { GodotConfig } from "effect-godot"

const ConfigLive = Layer.provide(
  GodotConfig.layerAddEnvironment,
  GodotConfig.layer,
)
```

Environment keys use `_` separators; ProjectSettings keys use `/` separators.

### `GodotHttpClient`

Implements Effect's `HttpClient` using Godot's `HTTPClient`:

```ts
import { Effect, Layer } from "effect"
import { GodotConnectionPool, GodotHttpClient } from "effect-godot"
import { HttpClient } from "effect/unstable/http"

const HttpLive = Layer.provide(
  GodotHttpClient.layer,
  GodotConnectionPool.layer,
)

const program = HttpClient.get("https://example.com").pipe(
  Effect.flatMap((response) => response.json),
  Effect.provide(HttpLive),
)
```

Use `GodotHttpClient.layerWithOptions(options)` to set `maxBodyBytes`, `readChunkSize`, or custom client/TLS factories. `GodotHttpClient.make(options?)` creates a plain client without a connection-pool dependency; requests use fresh connections.

### `GodotConnectionPool`

`GodotConnectionPool.layer` reuses Godot `HTTPClient` connections per host and closes idle connections when its layer scope closes. Provide it to `GodotHttpClient.layer` as shown above. A `RuntimeNode` is a convenient scope owner for both layers.

### `GodotCrypto`

Adapts Godot's `Crypto` to Effect's `Crypto.Crypto` service:

```ts
import { Effect } from "effect"
import { GodotCrypto } from "effect-godot"

const id = Effect.runSync(GodotCrypto.crypto.randomUUIDv4)
```

Use `GodotCrypto.layer` when an Effect requires the `Crypto.Crypto` service. Random bytes and UUIDs are supported; digest is currently not implemented.
