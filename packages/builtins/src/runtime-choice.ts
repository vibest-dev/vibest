import { Plugin } from "@vibest/plugin/effect"
import { Effect } from "effect"

export const runtimeChoicePlugin = () =>
  Plugin.define({
    id: "vibest.runtime-choice",
    effect: (context) =>
      context.agent.hook("start.before", (event) =>
        Effect.sync(() => {
          if (event.runtime === undefined && event.parentRuntime !== undefined) event.runtime = event.parentRuntime
        }),
      ),
  })
