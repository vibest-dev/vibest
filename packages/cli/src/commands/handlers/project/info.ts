import { Effect } from "effect"

import { json, vibest } from "../../../caller.ts"
import { Runtime } from "../../../framework/runtime.ts"
import { Commands } from "../../commands.ts"

export default Runtime.handler(Commands.commands.project.commands.info, () =>
  vibest((client) => client["Project.Info"]()).pipe(Effect.flatMap(json)),
)
