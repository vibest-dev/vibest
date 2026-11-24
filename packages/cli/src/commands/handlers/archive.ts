import { Effect } from "effect"

import { json, vibest } from "../../caller.ts"
import { Runtime } from "../../framework/runtime.ts"
import { parseSessionRef } from "../../session-ref.ts"
import { Commands } from "../commands.ts"

export default Runtime.handler(Commands.commands.archive, (o) =>
  vibest((client) => client.Archive({ ...parseSessionRef(o.id), keepWorktree: o.keepWorktree })).pipe(
    Effect.flatMap(json),
  ),
)
