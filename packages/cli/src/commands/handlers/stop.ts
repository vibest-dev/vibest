import { Effect } from "effect"

import { json, vibest } from "../../caller.ts"
import { Runtime } from "../../framework/runtime.ts"
import { parseSessionRef } from "../../session-ref.ts"
import { Commands } from "../commands.ts"

export default Runtime.handler(Commands.commands.stop, (o) =>
  vibest((client) => client.Stop(parseSessionRef(o.id))).pipe(Effect.flatMap(json)),
)
