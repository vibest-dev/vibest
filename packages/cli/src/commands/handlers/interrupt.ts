import { Effect, Option } from "effect"

import { json, vibest } from "../../caller.ts"
import { Runtime } from "../../framework/runtime.ts"
import { Commands } from "../commands.ts"

export default Runtime.handler(Commands.commands.interrupt, (o) =>
  vibest((client) =>
    client["server.session"]["session.interrupt"]({
      params: { id: o.id },
      query: Option.isSome(o.machine) ? { machine: o.machine.value } : {},
    }),
  ).pipe(Effect.flatMap(json)),
)
