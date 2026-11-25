import { Effect } from "effect"

import { json, toSessionRef, vibest } from "../../caller.ts"
import { Runtime } from "../../framework/runtime.ts"
import { Commands } from "../commands.ts"

export default Runtime.handler(Commands.commands.interrupt, (o) =>
  vibest((client) => client.Interrupt(toSessionRef(o.id, o.machine))).pipe(Effect.flatMap(json)),
)
