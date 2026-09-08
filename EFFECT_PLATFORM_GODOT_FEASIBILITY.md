# Feasibility: `effect-platform-godot`

## Conclusion

Yes — an Effect platform package for GodotJS is feasible and useful, provided
it is designed as a **Godot runtime adapter**, not as a partial Node.js clone.
The highest-value, portable surface is:

- a Godot-owned Effect runtime/lifecycle;
- a confined `user://` persistence/filesystem layer;
- HTTP and TCP client layers built on Godot networking;
- key-value storage, configuration, logging, time, and feature/platform
  detection;
- small integrations for Godot signals and the scene tree.

It is not realistic to promise parity with `@effect/platform-bun` on every
Godot export target. In particular, terminal I/O, arbitrary process spawning,
file watching, unrestricted host filesystem access, and general worker support
are either desktop-only, incomplete, unsafe for a shipped game, or unavailable
on Web exports. The package should model those as optional capability layers,
not provide a misleading universal default.

The core idea is sound for Painless: it gives the eventual NPC/LLM integration
typed failures, cancellation, resource ownership, retries, queues, streams,
and testable interfaces without making gameplay code depend on a server or
browser runtime.

## What exists in this repository

The game package already demonstrates that Effect can run inside its GodotJS
runtime. `WebView` creates a `Scope`, constructs a scoped RPC server, runs
Effects, and closes that scope when its Godot node exits the tree
([`packages/game/src/web-view/WebView.ts`](packages/game/src/web-view/WebView.ts)).
That is the correct lifecycle seam for a package-level runtime.

The project pins GodotJS with the `qjs-ng` engine. GodotJS exposes the Godot API
to TypeScript and supports npm dependencies, but its own project describes some
functionality as still under testing and worker support as experimental. It is
therefore an engine-hosted JavaScript environment, not Bun, Node, or a browser
with a complete Web Platform. [GodotJS repository](https://github.com/godotjs/GodotJS)

The current game bundler intentionally targets `browser`, emitting CommonJS
and externalising the engine-provided `godot` import. That makes pure Effect
code a reasonable dependency, but rules out implementations that quietly pull
in Node built-ins. The existing `@effect/platform-bun` dependency is suitable
for the `godot-bin` host CLI; it must not be used as the game runtime layer.

## Feasibility by service

| Service | Feasibility | Recommended approach | Important limits |
| --- | --- | --- | --- |
| Godot runtime and scopes | High | Bind a root `Scope` to an autoload or dedicated `Node`; expose `runFork`, supervised fibers, and shutdown on `_exit_tree`. | Engine API calls must remain on Godot's main thread. |
| Signal / scene integration | High | Wrap `connect`/disconnect in `Effect.async` plus a scoped finalizer; provide scene-tree timer and process-frame helpers. | Cancellation must disconnect signals and cancel/free temporary nodes. |
| Clock, Random, logging | High | Use Effect defaults where sufficient; add Godot-specific monotonic/frame time, `GD.print*`, and feature tags as separate services. | `Math.random` is not a game replay RNG; gameplay should use an explicit seeded RNG. |
| `Path` | High | Implement pure, POSIX-style path operations plus explicit `res://`/`user://` handling. | Do not silently turn virtual Godot URIs into host paths. |
| `FileSystem` | Medium | Start with a deliberately confined `user://` layer over `FileAccess` and `DirAccess`; expose read-only packaged-resource access separately. | `res://` is normally read-only in exports; symlinks, permissions, file watch, and universal atomic rename semantics do not map cleanly. |
| Key-value store | High | Store schema-encoded entries under `user://`, with a versioned file format and crash-safe replace where supported. | Web persistence can be unavailable; test `OS.is_userfs_persistent()`. |
| HTTP client | Medium-high | Own a pooled or ephemeral `HTTPRequest` node, translate completion signals into Effects, and cancel/free requests through scope finalizers. | `HTTPRequest` is response-buffer-oriented; a first version should set explicit body-size limits and document non-streaming responses. Web exports are subject to browser/CORS rules. |
| TCP / TLS socket | Medium | Adapt `StreamPeerTCP` and `StreamPeerTLS`, polling from Godot's process loop and exposing byte streams. | Requires careful backpressure, timeout, close, and TLS validation work; no browser/Web export parity. |
| WebSocket | Medium | A separate layer over Godot's WebSocket peer API. | Do not pretend this is a raw TCP socket. Browser policies still apply. |
| Crypto | Medium | Implement only algorithms backed by Godot's `HashingContext`/`Crypto`, or ship a narrowly scoped native backend. | Do not use QuickJS pseudo-randomness for secrets; define supported algorithms explicitly. |
| Child processes | Low for a public default | Desktop-only, opt-in adapter around `OS.execute_with_pipe`/process polling. | `OS.execute` blocks the main thread; spawned processes outlive Godot; unavailable or restricted on Web and sandboxed/mobile targets. |
| Terminal / stdio | Low | A development-only logging/console adapter, if needed. | A normal exported game has no interactive terminal or reliable stdin/stdout. |
| Workers | Low-medium | Defer until GodotJS worker behavior is stable and tested for the pinned engine. | GodotJS labels workers experimental; Godot objects generally cannot cross threads. |

Godot has the raw primitives needed for much of this work: `FileAccess` and
`DirAccess` for file I/O, high-level `HTTPRequest` and lower-level `HTTPClient`
for HTTP, `TCPServer`/stream peers for sockets, and OS process APIs on desktop.
Those APIs do not remove the portability and lifecycle work described above.
[FileAccess](https://docs.godotengine.org/en/stable/classes/class_fileaccess.html),
[DirAccess](https://docs.godotengine.org/en/stable/classes/class_diraccess.html),
[Godot HTTP overview](https://docs.godotengine.org/en/stable/tutorials/networking/http_client_class.html),
[OS process APIs](https://docs.godotengine.org/en/stable/classes/class_os.html).

## The main engineering constraint: Godot owns the thread

Effect code may run and suspend freely, but calls into a Godot object should be
made from the engine thread. A package must not let arbitrary fibers call a
`Node`, `FileAccess`, or networking peer from an Effect worker thread.

The package should therefore establish one engine scheduler:

```text
Godot `_process` / signal
        |
        v
Godot scheduler queue ----> resumes Effect callbacks on engine thread
        |                                      |
        |                                      v
        +-- scoped cancellation <--- Effect fibers / timeouts / shutdown
```

All async adapters should follow this pattern:

1. Allocate or attach the Godot object on the main thread.
2. Register signals or enqueue polling work.
3. Resume an `Effect.async` callback exactly once, on the main thread.
4. Add a scope finalizer that disconnects signals, cancels the request, and
   releases the object.

This is more important than the individual API wrappers. It protects scene
ownership, makes cancellation real, and avoids leaked `HTTPRequest` nodes or
subscriptions after a scene transition.

## Proposed package shape

Start in this workspace as `packages/effect-platform-godot` under the internal
scope `@codename-painless/effect-platform-godot`. Keep it independently
publishable; an unscoped `effect-platform-godot` package name or the
`@effect/*` namespace should not be assumed available.

```text
packages/effect-platform-godot/
  src/
    GodotRuntime.ts       # root node, scheduler, Effect runtime layer
    GodotSignal.ts        # scoped signal and process-frame helpers
    GodotFileSystem.ts    # user://-confined FileSystem subset/layer
    GodotPath.ts          # virtual URI-aware paths
    GodotKeyValueStore.ts
    GodotHttpClient.ts
    GodotSocket.ts        # later, separate optional layer
    GodotCrypto.ts        # later, explicitly limited algorithms
    GodotPlatform.ts      # OS feature/config/logging helpers
    index.ts
  test/                   # headless Godot integration project, not Node-only tests
```

Avoid an aggregate `layer` that claims to supply every Effect platform service.
Export small capability-specific layers, then offer two honest convenience
layers:

- `layerCore`: runtime, signals, logging, platform metadata, confined storage.
- `layerDesktop`: `layerCore` plus only the desktop capabilities that pass the
  integration suite for the active export target.

This mirrors Effect's dependency-injection model while making target support
visible in application requirements. Effect's current platform services include
`FileSystem`, `Path`, `Terminal`, `Stdio`, `Crypto`, process spawning, HTTP,
sockets, persistence, and workers; the Bun aggregate layer itself combines
process, crypto, filesystem, path, stdio, and terminal services. A Godot layer
should select, rather than imitate, that set. [Effect repository](https://github.com/Effect-TS/effect),
[Effect HTTP client source](https://github.com/Effect-TS/effect/blob/main/packages/effect/src/unstable/http/HttpClient.ts).

## API decisions that prevent future trouble

### Treat virtual paths as capabilities

Default writable paths should be `user://painless/...`; packaged `res://` data
should be read-only. Host absolute paths must require an explicit
desktop/development capability and a user-visible policy decision. This avoids
turning an in-game plugin into arbitrary host filesystem access.

### Keep gameplay determinism outside the platform RNG

Expose cryptographic randomness only for tokens/nonces when a real backend is
available. NPC simulation, procedural generation, and replayable gameplay need
their own deterministic, seedable service. They must not depend on OS entropy
or Effect's ambient random service.

### Make HTTP bodies bounded first

`HTTPRequest` maps well to request/response completion but not automatically to
an incrementally consumed response stream. A first release should buffer up to
a configured maximum, fail with a typed `BodyTooLarge` error, preserve headers,
status, redirects, and cancellation, and add streaming only after a lower-level
`HTTPClient` proof of concept.

### Do not make the LLM a Godot API caller

The prospective LLM/NPC service should depend on typed game-domain interfaces
(`NpcMemory`, `WorldObservation`, `NpcIntentExecutor`, `DialogueTransport`),
not `FileSystem` or raw nodes. The platform package may power remote inference
via HTTP and persisted memory via `KeyValueStore`, but the authoritative game
loop validates and executes all actions.

## Validation plan before committing to the package

Build these small, headless-Godot integration probes before designing the full
API:

1. **Scheduler probe:** fork 1,000 fibers that suspend on process-frame and
   scene-tree timers; switch scenes and verify every scoped finalizer runs once.
2. **Persistence probe:** read/write/list/remove data below `user://`; verify
   traversal rejection, missing-file errors, interrupted-write behavior, and
   Web persistence reporting.
3. **HTTP probe:** local test server plus cancellation, timeout, redirect,
   malformed TLS, large-body, and game-exit cases. Verify no temporary request
   node survives scope closure.
4. **Socket probe:** echo server with concurrent readers/writers, close races,
   timeouts, and TLS; run only on supported desktop targets initially.
5. **Export matrix:** run the same suite against editor, Linux desktop export,
   Windows export, macOS export, Android, and Web. Mark a layer unsupported
   rather than emulating it poorly.

The package should have real Godot integration tests. Node/Bun unit tests are
still useful for pure path and codec code, but cannot validate thread affinity,
signals, export permissions, or engine cleanup.

## Suggested delivery sequence

1. Create `GodotRuntime` and `GodotSignal`; migrate the current WebView scoped
   lifecycle to use them as the first consumer.
2. Add `GodotKeyValueStore` and the constrained `user://` filesystem layer.
   These immediately support saves, NPC memories, and cached LLM results.
3. Implement bounded `GodotHttpClient` for a single inference provider and
   prove cancellation/scene teardown behavior.
4. Add domain-level LLM adapters in the game, not in the platform package.
5. Evaluate sockets, crypto, and workers only when a concrete game feature
   requires them. Keep process/terminal support development-only unless there
   is a compelling shipped-game use case.

## Recommendation

Proceed with a small package, but call its first milestone **"Godot Effect
runtime + persistence + bounded HTTP"**, not a complete platform port. That
milestone is tractable, directly valuable to Painless, and creates the right
foundation for LLM-backed NPC systems. A broad compatibility claim before the
headless/export probes would create more maintenance burden than value.
