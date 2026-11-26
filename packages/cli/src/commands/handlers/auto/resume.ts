import { Effect } from "effect"

import { json, vibest } from "../../../caller.ts"
import { Runtime } from "../../../framework/runtime.ts"
import { Commands } from "../../commands.ts"

export default Runtime.handler(Commands.commands.auto.commands.resume, (o) =>
  vibest((client) =>
    client["server.automation"]["automation.resume"]({ params: { id: o.id } }).pipe(Effect.flatMap(json)),
  ),
)
