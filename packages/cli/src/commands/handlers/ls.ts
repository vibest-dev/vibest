import { Effect, Option } from "effect"

import { json, titled, vibest } from "../../caller.ts"
import { Runtime } from "../../framework/runtime.ts"
import { EmptyInput } from "../../input.ts"
import { Commands } from "../commands.ts"

export default Runtime.handler(Commands.commands.ls, (o) =>
  Effect.gen(function* () {
    if (!o.team && Option.isSome(o.name))
      return yield* new EmptyInput({
        message: `vibest ls takes a name only with --team: vibest ls --team ${o.name.value}`,
      })

    if (o.team)
      return yield* vibest((client) => client["Team.List"]({ team: Option.getOrUndefined(o.name) })).pipe(
        Effect.map((listed) => ({ team: listed.team, members: listed.members.map(titled) })),
        Effect.flatMap(json),
      )

    return yield* vibest((client) => client.List({ stopped: o.all })).pipe(
      Effect.map((listed) => ({ ...listed, sessions: listed.sessions.map(titled) })),
      Effect.flatMap(json),
    )
  }),
)
