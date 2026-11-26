import { Effect } from "effect"

import { json, vibest } from "../../../caller.ts"
import { Runtime } from "../../../framework/runtime.ts"
import { Commands } from "../../commands.ts"

export default Runtime.handler(Commands.commands.auto.commands.remove, (o) =>
  vibest((client) =>
    client["server.automation"]
      ["automation.remove"]({ params: { id: o.id } })
      .pipe(Effect.andThen(json({ removed: o.id }))),
  ),
)
