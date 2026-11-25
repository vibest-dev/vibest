import { Effect } from "effect"

import { json, vibest } from "../../caller.ts"
import { Runtime } from "../../framework/runtime.ts"
import { Commands } from "../commands.ts"

export default Runtime.handler(Commands.commands.plugins, () =>
  vibest((client) => client["server.plugin"]["plugin.list"]().pipe(Effect.flatMap(json))),
)
