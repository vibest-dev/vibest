import { Effect, Option } from "effect"

import { json } from "../../../caller.ts"
import { catalog } from "../../../catalog.ts"
import * as Runtime from "../../../framework/runtime.ts"
import { Commands } from "../../commands.ts"

export default Runtime.handler(Commands.commands.harness.commands.list, (o) =>
  Effect.gen(function* () {
    const choices = yield* catalog(undefined, Option.getOrUndefined(o.machine))
    yield* json(
      choices.map((c) => ({
        harness: c.harness,
        binary: c.binary,
        available: c.problem === null,
        defaultModel: c.models.find((m) => m.default)?.model ?? null,
        error: c.problem,
      })),
    )
  }),
)
