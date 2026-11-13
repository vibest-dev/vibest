import { Effect, Stdio, Stream } from "effect"

import { Runtime } from "../../../framework/runtime.ts"
import { integrationReady } from "../../../integration.ts"
import { Commands } from "../../commands.ts"

export default Runtime.handler(Commands.commands.integration.commands.ready, (o) =>
  Effect.gen(function* () {
    yield* Stream.mkString(Stream.decodeText((yield* Stdio.Stdio).stdin))
    yield* integrationReady(o.harness)
  }),
)
