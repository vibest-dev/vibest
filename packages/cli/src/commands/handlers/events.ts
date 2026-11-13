import { LaunchFailed } from "@vibest/schema/session"
import { Effect, Option, Stream } from "effect"

import { caller, json, userOnly } from "../../caller.ts"
import { withVibest } from "../../client.ts"
import * as Runtime from "../../framework/runtime.ts"
import { Commands } from "../commands.ts"

export default Runtime.handler(Commands.commands.events, (o) =>
  Effect.gen(function* () {
    yield* userOnly("events")
    const c = yield* caller
    yield* withVibest(c.claim, (client, ping) =>
      Effect.gen(function* () {
        if (ping.capabilities?.events !== true)
          return yield* new LaunchFailed({
            message: "this vibestd does not serve events; run vibest daemon restart",
          })
        yield* Stream.runForEach(
          client.Events({
            session: Option.getOrUndefined(o.session),
            after: Option.getOrUndefined(o.after),
            follow: o.follow,
          }),
          json,
        )
      }),
    )
  }),
)
