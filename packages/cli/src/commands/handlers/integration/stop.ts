import { Effect, Stdio, Stream } from "effect"

import { Runtime } from "../../../framework/runtime.ts"
import { integrationStop } from "../../../integration.ts"
import { Commands } from "../../commands.ts"

export default Runtime.handler(Commands.commands.integration.commands.stop, (o) =>
  Effect.gen(function* () {
    yield* integrationStop(o.harness, yield* Stream.mkString(Stream.decodeText((yield* Stdio.Stdio).stdin)))
  }),
)
