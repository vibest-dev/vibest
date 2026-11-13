import { Effect } from "effect"

import { json, titled, vibest } from "../../caller.ts"
import { Runtime } from "../../framework/runtime.ts"
import { Commands } from "../commands.ts"

export default Runtime.handler(Commands.commands.ls, (o) =>
  vibest((client) => client.List({ stopped: o.all })).pipe(
    Effect.map((listed) => ({ ...listed, sessions: listed.sessions.map(titled) })),
    Effect.flatMap(json),
  ),
)
