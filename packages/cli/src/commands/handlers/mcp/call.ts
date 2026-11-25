import { Mcp } from "@vibest/schema/mcp"
import { Effect, Option, Path, Schema } from "effect"

import { json, vibest } from "../../../caller.ts"
import { Runtime } from "../../../framework/runtime.ts"
import { Commands } from "../../commands.ts"

const decodeArgs = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Json))

export default Runtime.handler(Commands.commands.mcp.commands.call, (o) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const directory = path.resolve(".")
    const rawJson = Option.getOrUndefined(o.json)
    let args: Schema.JsonObject | undefined

    if (rawJson !== undefined && rawJson.trim().length > 0) {
      const parsed = yield* Effect.try({
        try: () => JSON.parse(rawJson),
        catch: (error) =>
          new Mcp.ConfigError({
            message: `Invalid JSON arguments: ${error instanceof Error ? error.message : String(error)}`,
          }),
      })

      const decoded = decodeArgs(parsed)

      if (Option.isNone(decoded)) {
        return yield* new Mcp.ConfigError({ message: "Tool arguments must be a JSON object" })
      }

      args = decoded.value
    }

    yield* vibest((client) =>
      client["server.mcp"]
        ["mcp.call"]({
          params: { server: o.server, tool: o.tool },
          payload: {
            ...(args !== undefined && { arguments: args }),
            directory,
          },
        })
        .pipe(Effect.flatMap(json)),
    )
  }),
)
