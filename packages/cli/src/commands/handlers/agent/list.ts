import { Effect, Option } from "effect"

import { json } from "../../../caller.ts"
import { Runtime } from "../../../framework/runtime.ts"
import { Commands } from "../../commands.ts"
import { agentListing } from "./listing.ts"

export default Runtime.handler(Commands.commands.agent.commands.list, (o) =>
  Effect.gen(function* () {
    const listing = yield* agentListing(Option.getOrUndefined(o.machine))
    yield* json({
      agents: listing.agents.map(({ system: _system, ...agent }) => agent),
      invalid: listing.invalid,
    })
  }),
)
