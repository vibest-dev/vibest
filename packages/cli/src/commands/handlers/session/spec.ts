import { EdgeChain, EdgeDirected, EdgeMutual, type EdgeSpec } from "@vibest/protocol/rpc"
import { Effect } from "effect"

import { EmptyInput } from "../../../input.ts"

export const edgeSpecOf = (o: {
  readonly ids: ReadonlyArray<string>
  readonly to: ReadonlyArray<string>
  readonly chain: boolean
}): Effect.Effect<EdgeSpec, EmptyInput> => {
  if (o.chain && o.to.length > 0) return Effect.fail(new EmptyInput({ message: "give --chain or --to, not both" }))

  if (o.chain) return Effect.succeed(EdgeChain.make({ ids: o.ids }))

  if (o.to.length > 0) return Effect.succeed(EdgeDirected.make({ from: o.ids, to: o.to }))

  return Effect.succeed(EdgeMutual.make({ ids: o.ids }))
}
