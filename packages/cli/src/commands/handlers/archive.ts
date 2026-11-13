import { Effect } from "effect"

import { json, vibest } from "../../caller.ts"
import * as Runtime from "../../framework/runtime.ts"
import { Commands } from "../commands.ts"

export default Runtime.handler(Commands.commands.archive, (o) =>
  vibest((client) => client.Remove({ id: o.id, keepWorktree: o.keepWorktree })).pipe(Effect.flatMap(json)),
)
