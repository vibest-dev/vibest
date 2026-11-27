import { Effect, Option } from "effect"

import { json, vibest } from "../../caller.ts"
import { Runtime } from "../../framework/runtime.ts"
import { Commands } from "../commands.ts"

export default Runtime.handler(Commands.commands.archive, (o) =>
  vibest((client) =>
    client["server.session"]["session.archive"]({
      params: { id: o.id },
      payload: {
        ...(Option.isSome(o.machine) && { machine: o.machine.value }),
        keepWorktree: o.keepWorktree,
      },
    }),
  ).pipe(Effect.flatMap(json)),
)
