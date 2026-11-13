import { Effect } from "effect"

import { json, vibest } from "../../caller.ts"
import { Runtime } from "../../framework/runtime.ts"
import { Commands } from "../commands.ts"

export default Runtime.handler(Commands.commands.interrupt, (o) =>
  vibest((client) => client.Interrupt({ id: o.id })).pipe(Effect.flatMap(json)),
)
