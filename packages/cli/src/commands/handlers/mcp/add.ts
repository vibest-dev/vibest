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

    if (o.args.length > 0 && o.command.length > 0) {
      return yield* new Mcp.ConfigError({
        message: "Specify local command either after -- or with --command, not both",
      })
    }

    const command = o.args.length > 0 ? o.args : o.command

    if (url !== undefined && command.length > 0) {
      return yield* new Mcp.ConfigError({ message: "Provide either --url or a local command, not both" })
    }

    const payload: Mcp.ServerConfig =
      url !== undefined
        ? {
            type: "remote",
            url,
            ...(bearerToken !== undefined && { bearerToken }),
            ...(exposure !== undefined && { exposure }),
            ...(idleTimeoutMs !== undefined && { idleTimeoutMs }),
          }
        : yield* command.length > 0
            ? Effect.succeed({
                type: "local" as const,
                command: [command[0]!, ...command.slice(1)] as const,
                ...(cwd !== undefined && { cwd }),
                ...(exposure !== undefined && { exposure }),
                ...(idleTimeoutMs !== undefined && { idleTimeoutMs }),
              })
            : Effect.fail(
                new Mcp.ConfigError({
                  message: "Provide either --url or a local command (-- <cmd> <args...> or --command)",
                }),
              )

    yield* vibest((client) =>
      client["server.mcp"]["mcp.add"]({ params: { server: o.server }, payload }).pipe(Effect.flatMap(json)),
    )
  }),
)
