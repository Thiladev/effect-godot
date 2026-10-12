# effect-godot

Experimental Effect v4 bindings for [GodotJS](https://github.com/godotjs/GodotJS), a QuickJS/V8-based JavaScript runtime for Godot.

## Quick setup

Install `effect` and `effect-godot`, then bundle your TypeScript scripts and your dependencies to CommonJS before Godot loads them. This is required since GodotJS can only load CommonJS scripts. Both `effect` and this library are ESM-only.

A minimal bundler configuration should use `format: "cjs"` and keep `godot` external. See the `game` package inside this monorepo for a bundler config example using Rolldown.

Both `effect` and this library also need some polyfills to run under GodotJS. Add this as the first JavaScript autoload in your load order:

```ts
// src/GodotPolyfill.ts
export { default } from "effect-godot/polyfill-autoload"
```

```ini
# project.godot
[autoload]
GodotPolyfill="*res://src/GodotPolyfill.ts"
```

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

## Effectful

To use Effect within ordinary Godot nodes, use the runtime class's `Effectful` trait. It preserves the base node class and adds:

- `runtimeNode`: the `RuntimeNode` found in the scene tree.
- `runSync(effect)`: runs an Effect synchronously with the runtime's services.
- `runPromise(effect, options?)`: runs an Effect as a promise.
- `runFork(effect, options?)`: forks an Effect using the runtime.

```ts
// src/GreeterLabel.ts
import { Effect } from "effect"
import { Label } from "godot"
import GameRuntime, { Greeter } from "./GameRuntime.js"

export default class GreeterLabel extends GameRuntime.Effectful(Label) {
  async _ready(): Promise<void> {
    await this.runPromise(
      Greeter.use((greeter) => greeter.greet("Godot")).pipe(
        Effect.tap((message) => Effect.sync(() => { this.text = message })),
      ),
    )
  }
}
```

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

const layer = Layer.provide(
  GodotConfig.layerAddEnvironment,
  GodotConfig.layer,
)
```

Environment keys use `_` separators; ProjectSettings keys use `/` separators.

### `GodotHttpClient`

Implements Effect's `HttpClient` using Godot's `HTTPClient`:

```ts
// src/Runtime.ts
import { Layer } from "effect"
import { GodotConnectionPool, GodotHttpClient, RuntimeNode } from "effect-godot"

const layer = Layer.provide(
  GodotHttpClient.layer,
  GodotConnectionPool.layer,
)

export default class Runtime extends RuntimeNode.RuntimeNode(layer) {}

// src/HttpClientNode.ts
import { Console, Effect, Inspectable } from "effect"
import { HttpClient } from "effect/http"
import { Node } from "godot"
import Runtime from "./Runtime.js"

export default class HttpClientNode extends Runtime.Effectful(Node) {
  async _ready(): Promise<void> {
    await this.runPromise(
      HttpClient.get("https://example.com").pipe(
        Effect.flatMap((response) => response.json),
        Effect.flatMap((body) => Console.log(Inspectable.toStringUnknown(body))),
      ),
    )
  }
}
```

`GodotConnectionPool` is a reusable pool of Godot `HTTPClient` connections. It should be long-lived and shared across requests and `HttpClient` instances. Keep its layer scope alive instead of creating a new pool for each request or client. `GodotHttpClient` can however be recreated with minimal impact.

Use `GodotHttpClient.layerWithOptions(options)` to set `maxBodyBytes`, `readChunkSize`.

### `GodotCrypto`

Adapts Godot's `Crypto` to Effect's `Crypto.Crypto` service:

```ts
import { Crypto, Effect } from "effect"
import { GodotCrypto } from "effect-godot"
import { Node } from "godot"

export default class CryptoNode extends Node {
  async _ready(): Promise<void> {
    await Effect.runPromise(
      Effect.gen(function* () {
        const crypto = yield* Crypto.Crypto
        const id = yield* crypto.randomUUIDv4
        console.log(id)
      }).pipe(
        Effect.provide(GodotCrypto.layer),
      ),
    )
  }
}
```

Use `GodotCrypto.layer` when an Effect requires the `Crypto.Crypto` service. Random bytes and UUIDs are supported, digest is currently not implemented.
