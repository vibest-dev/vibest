import { Effect, Stdio, Stream } from "effect"

import * as Runtime from "../../../framework/runtime.ts"
import { integrationPrompt } from "../../../integration.ts"
import { Commands } from "../../commands.ts"

export default Runtime.handler(Commands.commands.integration.commands.prompt, (o) =>
  Effect.gen(function* () {
    yield* integrationPrompt(o.harness, yield* Stream.mkString(Stream.decodeText((yield* Stdio.Stdio).stdin)))
  }),
)
