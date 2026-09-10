# effect-godot

Effect-TS bindings for [GodotJS](https://github.com/godotjs/GodotJS) (Godot's `quickjs-ng`-based JS runtime).

## Setup

Add `effect-godot` as a dependency, then wire up `GodotPolyfill` (below) as your project's first autoload.

`effect` ships ESM-only; GodotJS's `require()` is CommonJS-only with no ESM support. Any code using `effect-godot` must be bundled to CJS (e.g. rolldown, not plain `tsc`) before Godot loads it — see this repo's `packages/game/meta/rolldown.config.ts` for a working setup.

## Modules

### `GodotPolyfill` — `effect-godot/polyfill-autoload`

`quickjs-ng` has no `Intl`, `AbortController`, `URL`/`URLSearchParams`, or `TextEncoder`/`TextDecoder`. This installs all four on `globalThis`. Add as the *first* `[autoload]` in your project:

```ts
// src/GodotPolyfill.ts
export { default } from "effect-godot/polyfill-autoload"
```

```ini
[autoload]
GodotPolyfill="*res://src/GodotPolyfill.ts"
```

Everything below assumes this has run.

### `GodotHttpClient`

An `effect/unstable/http` `HttpClient` backed by Godot's low-level `HTTPClient` node, with streaming request/response bodies and TLS support.

```ts
import { Effect, Layer } from "effect"
import { GodotConnectionPool, GodotHttpClient } from "effect-godot"
import { HttpClient } from "effect/unstable/http"

const program = HttpClient.get("https://example.com").pipe(
    Effect.flatMap((res) => res.json),
)

await program.pipe(
    Effect.provide(Layer.provide(GodotHttpClient.layer, GodotConnectionPool.layer)),
    Effect.runPromise,
)
```

- `GodotHttpClient.make(options?)` — a plain `HttpClient`, no pooling: one fresh connection per request.
- `GodotHttpClient.layer` / `layerWithOptions(options)` — the `HttpClient` service; requires a `GodotConnectionPool` in scope (see below).

`options` (`GodotHttpClientOptions`) lets you override `createClient`/`createTlsOptions` (e.g. for tests) and cap `maxBodyBytes`/`readChunkSize`.

### `GodotConnectionPool`

Reuses `HTTPClient` connections per host across requests, per Godot's own guidance against reconnecting on every request. `GodotHttpClient.layer` needs one provided explicitly — its `Scope` (and when it closes, closing every idle connection) is yours to control:

```ts
import { Layer } from "effect"
import { GodotConnectionPool, GodotHttpClient } from "effect-godot"

const HttpLive = Layer.provide(GodotHttpClient.layer, GodotConnectionPool.layer)
```

### `GodotRuntime`

The lifetime owner for Effects started from a Godot node or autoload. A layer's `Scope` backs `runFork`; closing it interrupts every forked fiber — one place for a Godot lifecycle hook (`_exit_tree`, autoload teardown) to cancel background work.

```ts
import { Effect } from "effect"
import { GodotRuntime } from "effect-godot"

class MyAutoload extends Node {
    async _ready() {
        await Effect.runPromise(
            GodotRuntime.runFork(myBackgroundEffect).pipe(
                Effect.provide(GodotRuntime.GodotRuntimeLayer),
            ),
        )
    }
}
```

## Notes

- The main barrel (`effect-godot`) never imports real Godot runtime values — safe to import anywhere. `polyfill-autoload` is the one subpath that does, kept separate on purpose.
- `GodotHttpClient` targets Godot's `HTTPClient` state machine directly; polling is paced to `SceneTree.process_frame`, matching Godot's own documented usage pattern.
