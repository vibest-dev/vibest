import { LaunchFailed } from "@vibest/schema/session"
import { Effect } from "effect"

import { vibest } from "../../../caller.ts"

export const agentListing = (machine: string | undefined) =>
  vibest((client, _agent, ping) =>
    Effect.gen(function* () {
      if (ping.capabilities?.agents !== true)
        return yield* new LaunchFailed({ message: "this vibestd does not list agent definitions; run vibest update" })

      return yield* client["server.agent"]["agent.list"]({ query: { machine } })
    }),
  )
