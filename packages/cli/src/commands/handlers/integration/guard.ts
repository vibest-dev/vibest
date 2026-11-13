import { Config, Effect, Stdio, Stream } from "effect"

import { json } from "../../../caller.ts"
import { Runtime } from "../../../framework/runtime.ts"
import { notify } from "../../../integration.ts"
import { Commands } from "../../commands.ts"

export default Runtime.handler(Commands.commands.integration.commands.guard, (o) =>
  Effect.gen(function* () {
    const sessionId = yield* Config.String("VIBEST_SESSION_ID")
    const input = yield* Stream.mkString(Stream.decodeText((yield* Stdio.Stdio).stdin))
    const { answer } = yield* notify(o.harness, sessionId, "guard", (client) =>
      client["Integration.Guard"]({ harness: o.harness, input }),
    )
    if (answer !== undefined) yield* json(answer)
  }),
)
