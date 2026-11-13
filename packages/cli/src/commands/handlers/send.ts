import { Effect } from "effect"

import { json } from "../../caller.ts"
import { Runtime } from "../../framework/runtime.ts"
import { input } from "../../input.ts"
import { requested } from "../../requested.ts"
import { Commands } from "../commands.ts"

export default Runtime.handler(Commands.commands.send, (o) =>
  Effect.gen(function* () {
    const message = yield* input(o.message, "message")
    const sent = yield* requested((client, request) =>
      client.Send({ id: o.id, message, ...(request === undefined ? {} : { request }) }),
    )
    yield* json({ id: sent.id, queued: true })
  }),
)
