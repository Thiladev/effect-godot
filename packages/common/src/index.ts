// JSON-safe data and protocol modules shared by the Godot runtime and the
// UI. Runtime-specific behavior stays in packages/game and packages/ui.
//
// Organized the way `effect` organizes itself: one module per file, each
// re-exported here as a namespace.

export * as Events from "./Events"
export * as Procedures from "./Procedures"
export * as RpcClient from "./RpcClient"
export * as RpcMessage from "./RpcMessage"
export * as RpcServer from "./RpcServer"
