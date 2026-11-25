import { Effect, Option } from "effect"

import { json, titled, vibest } from "../../caller.ts"
import { Runtime } from "../../framework/runtime.ts"
import { Commands } from "../commands.ts"

export default Runtime.handler(Commands.commands.result, (o) =>
  vibest((client) => client.Get({ id: o.id, ...(Option.isSome(o.machine) && { machine: o.machine.value }) })).pipe(
    Effect.map(titled),
    Effect.flatMap(json),
  ),
)
