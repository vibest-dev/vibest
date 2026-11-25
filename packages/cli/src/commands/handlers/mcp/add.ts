import { Mcp } from "@vibest/schema/mcp"
import { Effect, Option } from "effect"

import { json, vibest } from "../../../caller.ts"
import { Runtime } from "../../../framework/runtime.ts"
import { Commands } from "../../commands.ts"

export default Runtime.handler(Commands.commands.mcp.commands.add, (o) =>
  Effect.gen(function* () {
    const url = Option.getOrUndefined(o.url)
    const cwd = Option.getOrUndefined(o.cwd)
    const exposure = Option.getOrUndefined(o.exposure)
    const bearerToken = Option.getOrUndefined(o.bearerToken)
    const idleTimeoutMs = Option.getOrUndefined(o.idleTimeout)

    const payload: Mcp.ServerConfig =
      url !== undefined
        ? {
            type: "remote",
            url,
            ...(bearerToken !== undefined && { bearerToken }),
            ...(exposure !== undefined && { exposure }),
            ...(idleTimeoutMs !== undefined && { idleTimeoutMs }),
          }
        : yield* o.command.length > 0
            ? Effect.succeed({
                type: "local" as const,
                command: [o.command[0]!, ...o.command.slice(1)] as const,
                ...(cwd !== undefined && { cwd }),
                ...(exposure !== undefined && { exposure }),
                ...(idleTimeoutMs !== undefined && { idleTimeoutMs }),
              })
            : Effect.fail(new Mcp.ConfigError({ message: "Provide either --url or --command" }))

    yield* vibest((client) =>
      client["server.mcp"]["mcp.add"]({ params: { server: o.server }, payload }).pipe(Effect.flatMap(json)),
    )
  }),
)
