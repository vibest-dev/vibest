import { Effect } from "effect"

import { json, vibest } from "../../../caller.ts"
import { Runtime } from "../../../framework/runtime.ts"
import { Commands } from "../../commands.ts"
import { edgeSpecOf } from "./spec.ts"

export default Runtime.handler(Commands.commands.session.commands.unlink, (o) =>
  edgeSpecOf(o).pipe(
    Effect.flatMap((spec) => vibest((client) => client["Session.Unlink"]({ spec }))),
    Effect.flatMap(json),
  ),
)
