import { Effect, Option } from "effect"

import { json, vibest } from "../../../caller.ts"
import { Runtime } from "../../../framework/runtime.ts"
import { Commands } from "../../commands.ts"

export default Runtime.handler(Commands.commands.automation.commands.list, (o) =>
  Effect.gen(function* () {
    const status = Option.getOrUndefined(o.status)
    const sessionId = Option.getOrUndefined(o.session)
    const projectId = Option.getOrUndefined(o.project)

    yield* vibest((client) =>
      client["server.automation"]
        ["automation.list"]({
          query: {
            ...(status !== undefined && { status }),
            ...(sessionId !== undefined && { sessionId }),
            ...(projectId !== undefined && { projectId }),
          },
        })
        .pipe(Effect.flatMap(json)),
    )
  }),
)
