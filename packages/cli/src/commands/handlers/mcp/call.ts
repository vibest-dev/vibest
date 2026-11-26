import { Json } from "@vibest/schema/json"
import { Mcp } from "@vibest/schema/mcp"
import { Effect, Option, Path, type Schema } from "effect"

import { json, vibest } from "../../../caller.ts"
import { Runtime } from "../../../framework/runtime.ts"
import { Commands } from "../../commands.ts"

const parseTarget = (
  rawServer: string,
  rawTool: string | undefined,
  rawJson: string | undefined,
): Effect.Effect<
  { readonly server: string; readonly tool: string; readonly jsonText: string | undefined },
  Mcp.ConfigError
> => {
  const dot = rawServer.indexOf(".")

  if (dot > 0 && dot < rawServer.length - 1 && rawJson === undefined) {
    return Effect.succeed({
      server: rawServer.slice(0, dot),
      tool: rawServer.slice(dot + 1),
      jsonText: rawTool,
    })
  }

  if (rawTool === undefined || rawTool.trim().length === 0) {
    return Effect.fail(new Mcp.ConfigError({ message: "Specify <server> <tool> [json] or <server.tool> [json]" }))
  }

  return Effect.succeed({ server: rawServer, tool: rawTool, jsonText: rawJson })
}

export default Runtime.handler(Commands.commands.mcp.commands.call, (o) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const directory = path.resolve(".")
    const target = yield* parseTarget(o.server, Option.getOrUndefined(o.tool), Option.getOrUndefined(o.json))
    let args: Schema.JsonObject | undefined

    if (target.jsonText !== undefined && target.jsonText.trim().length > 0) {
      const decoded = Json.parseJsonOption(target.jsonText)

      if (Option.isNone(decoded) || !Json.isJsonObject(decoded.value)) {
        return yield* new Mcp.ConfigError({ message: "Tool arguments must be a JSON object" })
      }

      args = decoded.value
    }

    yield* vibest((client) =>
      client["server.mcp"]
        ["mcp.call"]({
          params: { server: target.server, tool: target.tool },
          payload: {
            ...(args !== undefined && { arguments: args }),
            directory,
          },
        })
        .pipe(Effect.flatMap(json)),
    )
  }),
)
