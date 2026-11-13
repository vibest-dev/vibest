import { probe, startDaemon } from "@vibest/client/client"
import { Layout } from "@vibest/schema/layout"
import { Effect } from "effect"

import { userOnly } from "../../caller.ts"
import { pipeStdio } from "../../connect.ts"
import * as Runtime from "../../framework/runtime.ts"
import { Commands } from "../commands.ts"

export default Runtime.handler(Commands.commands.connect, () =>
  userOnly("connect").pipe(
    Effect.andThen(
      Effect.gen(function* () {
        const layout = yield* Layout
        if (!(yield* probe(layout.socket))) yield* startDaemon
        yield* pipeStdio(layout.socket)
      }),
    ),
  ),
)
