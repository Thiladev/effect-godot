import { Array as Arr, Context, Effect, Layer, pipe, Ref } from "effect"
import type { HTTPClient as GodotHTTPClient } from "godot"

/**
 * Reuses connected `HTTPClient` instances across requests to the same host,
 * instead of closing and recreating one per request. Keyed by
 * scheme+host+port, since `connect_to_host` binds a client to exactly one
 * destination — a request to a different host always creates its own
 * connection, pooled separately.
 *
 * Godot's `HTTPClient` is a single serial state machine (one
 * connect/request/read cycle at a time), so this only ever hands out a given
 * client to one in-flight request at a time: `checkout` removes it from the
 * idle set, and it isn't visible again until `release`d.
 */
export interface GodotConnectionPoolShape {
    /** Removes and returns an idle connection for `key`, if one exists. */
    readonly checkout: (key: string) => Effect.Effect<GodotHTTPClient | undefined>
    /** Returns a still-connected client to the pool for reuse. */
    readonly release: (key: string, client: GodotHTTPClient) => Effect.Effect<void>
}

export class GodotConnectionPool extends Context.Service<
    GodotConnectionPool,
    GodotConnectionPoolShape
>()("effect-godot/GodotConnectionPool") {}

/** Best-effort close; the connection may already be in a terminal state. */
export const closeQuietly = (client: GodotHTTPClient): void => {
    try {
        client.close()
    } catch {
        // ignored
    }
}

type IdleByHost = ReadonlyMap<string, ReadonlyArray<GodotHTTPClient>>

interface PoolState {
    readonly idle: IdleByHost
    readonly closed: boolean
}

const popIdle = (idle: IdleByHost, key: string): readonly [GodotHTTPClient | undefined, IdleByHost] => {
    const list = idle.get(key)
    if (list === undefined || list.length === 0) return [undefined, idle]

    const rest = list.slice(0, -1)
    const next = new Map(idle)
    if (rest.length === 0) next.delete(key)
    else next.set(key, rest)
    return [list[list.length - 1], next]
}

const pushIdle = (idle: IdleByHost, key: string, client: GodotHTTPClient): IdleByHost => {
    const next = new Map(idle)
    next.set(key, [...(idle.get(key) ?? []), client])
    return next
}

/**
 * Provides a `GodotConnectionPool` whose state lives in a `Ref`. Every idle
 * connection is closed when the layer's `Scope` closes; a connection
 * released after that point is closed immediately instead of being kept.
 */
export const layer: Layer.Layer<GodotConnectionPool> = Layer.effect(
    GodotConnectionPool,
    Effect.acquireRelease(Ref.make<PoolState>({ idle: new Map(), closed: false }), (state) =>
        Ref.getAndSet(state, { idle: new Map(), closed: true }).pipe(
            Effect.map(({ idle }) => pipe(Arr.fromIterable(idle.values()), Arr.flatten, Arr.forEach(closeQuietly))),
        ),
    ).pipe(
        Effect.map(
            (state): GodotConnectionPoolShape => ({
                checkout: (key) =>
                    Ref.modify(state, (current) => {
                        const [client, idle] = popIdle(current.idle, key)
                        return [client, { ...current, idle }]
                    }),
                release: (key, client) =>
                    Ref.modify(state, (current) =>
                        current.closed
                            ? [true, current]
                            : [false, { ...current, idle: pushIdle(current.idle, key, client) }],
                    ).pipe(
                        Effect.flatMap((wasClosed) => (wasClosed ? Effect.sync(() => closeQuietly(client)) : Effect.void)),
                    ),
            }),
        ),
    ),
)
