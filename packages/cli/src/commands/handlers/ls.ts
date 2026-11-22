import { Forbidden } from "@vibest/protocol/rpc"
import { LaunchFailed } from "@vibest/schema/session"
import { Effect } from "effect"

import { caller, json, titled, vibest } from "../../caller.ts"
import { Runtime } from "../../framework/runtime.ts"
import { EmptyInput } from "../../input.ts"
import { Commands } from "../commands.ts"

export default Runtime.handler(Commands.commands.ls, (o) =>
  Effect.gen(function* () {
    if (o.team.length > 1) return yield* new EmptyInput({ message: "give --team only once" })

    if (o.team.length === 1) {
      if (!(yield* caller).agent)
        return yield* new Forbidden({
          method: "ls",
          message: "vibest ls --team is run by an agent in a session",
        })
      const team = o.team[0] || undefined

      return yield* vibest((client, _agent, ping) =>
        Effect.gen(function* () {
          if (ping.capabilities?.teams !== true)
            return yield* new LaunchFailed({
              message: "this vibestd does not take --team on vibest ls; run vibest update",
            })

          return yield* client["Team.List"](team === undefined ? {} : { team })
        }),
      ).pipe(
        Effect.map((listed) => ({ team: listed.team, members: listed.members.map(titled) })),
        Effect.flatMap(json),
      )
    }

    return yield* vibest((client) => client.List({ stopped: o.all })).pipe(
      Effect.map((listed) => ({ ...listed, sessions: listed.sessions.map(titled) })),
      Effect.flatMap(json),
    )
  }),
)
