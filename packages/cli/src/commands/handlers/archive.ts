import { Effect } from "effect"

import { json, toSessionRef, vibest } from "../../caller.ts"
import { Runtime } from "../../framework/runtime.ts"
import { Commands } from "../commands.ts"

export default Runtime.handler(Commands.commands.archive, (o) =>
  vibest((client) =>
    client.Archive({
      ...toSessionRef(o.id, o.machine),
      keepWorktree: o.keepWorktree,
    }),
  ).pipe(Effect.flatMap(json)),
)
