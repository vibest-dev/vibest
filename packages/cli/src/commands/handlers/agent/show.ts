import { UnknownAgent } from "@vibest/schema/session"
import { Effect, Option } from "effect"

import { json, vibest } from "../../../caller.ts"
import { Runtime } from "../../../framework/runtime.ts"
import { Commands } from "../../commands.ts"

export default Runtime.handler(Commands.commands.agent.commands.show, (o) =>
  Effect.gen(function* () {
    const listing = yield* vibest((client) => client["Agents.List"]({ machine: Option.getOrUndefined(o.machine) }))
    const found = listing.agents.find((agent) => agent.id === o.id)

    if (found !== undefined) return yield* json(found)
    const rejected = listing.invalid.findLast((agent) => agent.id === o.id)

    return yield* new UnknownAgent({
      agent: o.id,
      known: listing.agents.map(({ id, description }) => ({ id, description })),
      ...(rejected !== undefined && { invalid: `${rejected.source}: ${rejected.error}` }),
    })
  }),
)
