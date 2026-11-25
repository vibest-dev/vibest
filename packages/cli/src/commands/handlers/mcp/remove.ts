import { Effect } from "effect"

import { json, vibest } from "../../../caller.ts"
import { Runtime } from "../../../framework/runtime.ts"
import { Commands } from "../../commands.ts"

export default Runtime.handler(Commands.commands.mcp.commands.remove, (o) =>
  vibest((client) =>
    client["server.mcp"]
      ["mcp.remove"]({ params: { server: o.server } })
      .pipe(Effect.andThen(json({ removed: o.server }))),
  ),
)
