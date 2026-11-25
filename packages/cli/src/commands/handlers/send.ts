import { Effect, Option } from "effect"

import { json } from "../../caller.ts"
import { Runtime } from "../../framework/runtime.ts"
import { input } from "../../input.ts"
import { requested } from "../../requested.ts"
import { Commands } from "../commands.ts"

export default Runtime.handler(Commands.commands.send, (o) =>
  Effect.gen(function* () {
    const message = yield* input(o.message, "message")

    const sent = yield* requested((client, request) =>
      client.Send({
        id: o.id,
        ...(Option.isSome(o.machine) && { machine: o.machine.value }),
        message,
        ...(request !== undefined && { request }),
      }),
    )

    yield* json({ id: sent.id, ...(sent.machine !== undefined && { machine: sent.machine }), queued: true })
  }),
)
