import { Effect } from "effect"

import { json, userOnly, vibest } from "../../../caller.ts"
import { Runtime } from "../../../framework/runtime.ts"
import { Commands } from "../../commands.ts"

export default Runtime.handler(Commands.commands.machine.commands.ls, () =>
  userOnly("machine ls").pipe(Effect.andThen(vibest((client) => client["Machine.List"]())), Effect.flatMap(json)),
)
