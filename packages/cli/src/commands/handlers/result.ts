import { Effect } from "effect"

import { json, titled, vibest } from "../../caller.ts"
import { Runtime } from "../../framework/runtime.ts"
import { Commands } from "../commands.ts"

export default Runtime.handler(Commands.commands.result, (o) =>
  vibest((client) => client.Get({ id: o.id })).pipe(Effect.map(titled), Effect.flatMap(json)),
)
