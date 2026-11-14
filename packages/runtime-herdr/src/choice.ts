import * as VibestPlugin from "@vibest/plugin/effect"
import { Effect } from "effect"

export const choicePlugin = (): VibestPlugin.Plugin.Plugin =>
  VibestPlugin.Plugin.define({
    id: "runtime-choice",
    effect: (context) =>
      context.agent.hook("start.before", (event) =>
        Effect.sync(() => {
          if (event.runtime === undefined && event.parentRuntime !== undefined) event.runtime = event.parentRuntime
        }),
      ),
  })
