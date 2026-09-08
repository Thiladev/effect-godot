// The events the game can push to the UI, over RpcClient/RpcServer's
// pseudo-RPC engine. Unlike procedures these are unsolicited broadcasts:
// nothing correlates them to a request.
//
// Empty for now — no events defined yet.

import { Schema } from "effect"

export const Event = Schema.TaggedUnion({})
export type Event = typeof Event.Type
