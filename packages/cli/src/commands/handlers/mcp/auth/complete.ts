import { Effect, Option } from "effect"

import { json, vibest } from "../../../../caller.ts"
import { Runtime } from "../../../../framework/runtime.ts"
import { Commands } from "../../../commands.ts"

export default Runtime.handler(Commands.commands.mcp.commands.auth.commands.complete, (o) => {
  const state = Option.getOrUndefined(o.state)

  return vibest((client) =>
    client["server.mcp"]
      ["mcp.authComplete"]({
        params: { server: o.server },
        payload: {
          redirectUrlOrCode: o.redirect,
          ...(state !== undefined && { state }),
        },
      })
      .pipe(Effect.flatMap(json)),
  )
})
