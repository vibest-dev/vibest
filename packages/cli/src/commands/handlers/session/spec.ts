import { EdgeChain, EdgeDirected, EdgeMutual, type EdgeSpec } from "@vibest/protocol/rpc"
import { Effect, Option } from "effect"

import { toSessionRef } from "../../../caller.ts"
import { EmptyInput } from "../../../input.ts"

export const edgeSpecOf = (o: {
  readonly ids: ReadonlyArray<string>
  readonly machine: Option.Option<string>
  readonly to: ReadonlyArray<string>
  readonly toMachine: Option.Option<string>
  readonly chain: boolean
}): Effect.Effect<EdgeSpec, EmptyInput> => {
  if (o.chain && o.to.length > 0) return Effect.fail(new EmptyInput({ message: "give --chain or --to, not both" }))

  if (Option.isSome(o.toMachine) && o.to.length === 0)
    return Effect.fail(new EmptyInput({ message: "--to-machine needs --to" }))

  const ids = o.ids.map((id) => toSessionRef(id, o.machine))

  if (o.chain) return Effect.succeed(EdgeChain.make({ ids }))

  if (o.to.length > 0)
    return Effect.succeed(EdgeDirected.make({ from: ids, to: o.to.map((id) => toSessionRef(id, o.toMachine)) }))

  return Effect.succeed(EdgeMutual.make({ ids }))
}
