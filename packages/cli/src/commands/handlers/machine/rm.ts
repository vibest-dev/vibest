import { Effect } from "effect"

import { json, userOnly, vibest } from "../../../caller.ts"
import { Runtime } from "../../../framework/runtime.ts"
import { Commands } from "../../commands.ts"

export default Runtime.handler(Commands.commands.machine.commands.remove, (o) =>
  userOnly("machine remove").pipe(
    Effect.andThen(vibest((client) => client["server.machine"]["machine.remove"]({ params: { name: o.name } }))),
    Effect.flatMap((removed) => json({ removed: o.name, notes: removed.notes })),
  ),
)
