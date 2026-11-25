import { Effect, Option } from "effect"

import { json, vibest } from "../../../caller.ts"
import { Runtime } from "../../../framework/runtime.ts"
import { Commands } from "../../commands.ts"

export default Runtime.handler(Commands.commands.project.commands.search, (o) =>
  vibest((client) =>
    client["server.project"]["project.search"]({ query: { query: o.query, kind: Option.getOrUndefined(o.kind) } }),
  ).pipe(Effect.flatMap((hits) => json({ hits }))),
)
