import { Effect, Path } from "effect"

import { json, vibest } from "../../../caller.ts"
import { Runtime } from "../../../framework/runtime.ts"
import { Commands } from "../../commands.ts"

export default Runtime.handler(Commands.commands.mcp.commands.list, () =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const directory = path.resolve(".")

    yield* vibest((client) => client["server.mcp"]["mcp.list"]({ query: { directory } }).pipe(Effect.flatMap(json)))
  }),
)
