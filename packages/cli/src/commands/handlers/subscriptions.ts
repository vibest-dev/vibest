import { Effect } from "effect"

import { json, vibest } from "../../caller.ts"
import * as Runtime from "../../framework/runtime.ts"
import { Commands } from "../commands.ts"

export default Runtime.handler(Commands.commands.subscriptions, () =>
  vibest((client) => client.Subscriptions().pipe(Effect.flatMap(json))),
)
