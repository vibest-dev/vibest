import { LaunchFailed } from "@vibest/schema/session"
import { Console, Effect } from "effect"

import { userOnly, vibest } from "../../caller.ts"
import { Runtime } from "../../framework/runtime.ts"
import { chooseHarness, chooseRuntime, runtimeLabel, savedSetting } from "../../onboard.ts"
import { Commands } from "../commands.ts"

export default Runtime.handler(Commands.commands.onboard, () =>
  Effect.gen(function* () {
    yield* userOnly("onboard")

    yield* vibest((client) =>
      Effect.gen(function* () {
        const current = yield* savedSetting("defaultRuntime")

        if (current !== undefined) yield* Console.log(`Your default runtime is ${runtimeLabel(current)}.`)

        const runtime = yield* chooseRuntime(client, { reuse: false, saveWithoutAsking: true })

        if (runtime === undefined)
          return yield* new LaunchFailed({
            message: "vibest onboard asks questions: run it on an interactive terminal",
          })

        const harness = yield* chooseHarness(client, { saveWithoutAsking: true })

        yield* Console.log(
          [
            `Runtime: ${runtimeLabel(runtime)}`,
            `Coding agent: ${harness ?? "none is ready; install Claude Code, Pi, Cursor or agy, then run vibest onboard again"}`,
            harness === undefined ? "" : "Ready. Run vibest in any git repository to start.",
          ]
            .filter((line) => line !== "")
            .join("\n"),
        )
      }),
    )
  }),
)
