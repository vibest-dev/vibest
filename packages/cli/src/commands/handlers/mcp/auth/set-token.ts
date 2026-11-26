import { Effect, Option } from "effect"

import { json, vibest } from "../../../../caller.ts"
import { Runtime } from "../../../../framework/runtime.ts"
import { Commands } from "../../../commands.ts"

export default Runtime.handler(Commands.commands.mcp.commands.auth.commands["set-token"], (o) => {
  const refreshToken = Option.getOrUndefined(o.refreshToken)
  const scope = Option.getOrUndefined(o.scope)

  return vibest((client) =>
    client["server.mcp"]
      ["mcp.authSetToken"]({
        params: { server: o.server },
        payload: {
          accessToken: o.token,
          ...(refreshToken !== undefined && { refreshToken }),
          ...(scope !== undefined && { scope }),
        },
      })
      .pipe(Effect.flatMap(json)),
  )
})
