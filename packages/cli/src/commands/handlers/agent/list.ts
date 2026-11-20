import { Effect, Option } from "effect"

import { json, vibest } from "../../../caller.ts"
import { Runtime } from "../../../framework/runtime.ts"
import { Commands } from "../../commands.ts"

export default Runtime.handler(Commands.commands.agent.commands.list, (o) =>
  Effect.gen(function* () {
    const listing = yield* vibest((client) => client["Agents.List"]({ machine: Option.getOrUndefined(o.machine) }))
    yield* json({
      agents: listing.agents.map(({ system: _system, ...agent }) => agent),
      invalid: listing.invalid,
    })
  }),
)
