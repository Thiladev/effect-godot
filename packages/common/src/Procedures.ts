// The procedures the UI can trigger on the game, over RpcClient/RpcServer's
// pseudo-RPC engine. Each tag pairs a request shape with the success/error
// schema its response is decoded against.
//
// Empty for now — no procedures defined yet.

import { Schema } from "effect"

export const Request = Schema.TaggedUnion({})
export type Request = typeof Request.Type

export const success = {} satisfies Record<Request["_tag"], Schema.Top>

export const error = {} satisfies Record<Request["_tag"], Schema.Top>
