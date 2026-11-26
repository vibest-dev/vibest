import { Mcp } from "@vibest/schema/mcp"
import { Console, Effect, Option, Path } from "effect"

import { json, vibest } from "../../../caller.ts"
import { Runtime } from "../../../framework/runtime.ts"
import { Commands } from "../../commands.ts"

export default Runtime.handler(Commands.commands.mcp.commands.list, (o) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const directory = path.resolve(".")
    const server = Option.getOrUndefined(o.server)
    const tool = Option.getOrUndefined(o.tool)

    const filterCount = [o.events, o.skills, o.types].filter(Boolean).length

    if (filterCount > 1) {
      return yield* new Mcp.ConfigError({ message: "Specify at most one of --events, --skills, or --types" })
    }

    if (o.types) {
      if (tool !== undefined) {
        return yield* new Mcp.ConfigError({ message: "--types cannot be combined with a <tool> argument" })
      }

      yield* vibest((client) =>
        client["server.codemode"]
          ["codemode.declarations"]({
            query: {
              directory,
              ...(server !== undefined && { server }),
            },
          })
          .pipe(Effect.flatMap((result) => Console.log(result.declarations))),
      )

      return
    }

    if (server === undefined) {
      if (o.events || o.skills) {
        return yield* new Mcp.ConfigError({ message: "--events and --skills require a <server> argument" })
      }

      yield* vibest((client) => client["server.mcp"]["mcp.list"]({ query: { directory } }).pipe(Effect.flatMap(json)))

      return
    }

    if (tool !== undefined) {
      yield* vibest((client) =>
        client["server.mcp"]
          ["mcp.describe"]({ params: { server, tool }, query: { directory } })
          .pipe(Effect.flatMap(json)),
      )

      return
    }

    if (o.events) {
      yield* vibest((client) =>
        client["server.mcp"]["mcp.events"]({ params: { server }, query: { directory } }).pipe(Effect.flatMap(json)),
      )

      return
    }

    if (o.skills) {
      yield* vibest((client) =>
        client["server.mcp"]["mcp.skills"]({ params: { server }, query: { directory } }).pipe(Effect.flatMap(json)),
      )

      return
    }

    yield* vibest((client) =>
      Effect.gen(function* () {
        const tools = yield* client["server.mcp"]["mcp.tools"]({ query: { server, directory } })

        const skills = yield* client["server.mcp"]
          ["mcp.skills"]({ params: { server }, query: { directory } })
          .pipe(Effect.orElseSucceed(() => []))

        const events = yield* client["server.mcp"]
          ["mcp.events"]({ params: { server }, query: { directory } })
          .pipe(Effect.orElseSucceed(() => []))

        yield* json({ server, tools, skills, events })
      }),
    )
  }),
)
