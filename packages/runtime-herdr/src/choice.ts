import * as VibestPlugin from "@vibest/plugin"
import { Effect } from "effect"

export const choicePlugin = (): VibestPlugin.Plugin.Plugin =>
  VibestPlugin.Plugin.define({
    id: "runtime-choice",
    effect: (context) =>
      context.agent.hook("start.before", (event) =>
        Effect.succeed(
          event.runtime === undefined && event.parentRuntime !== undefined
            ? { runtime: event.parentRuntime }
            : undefined,
        ),
      ),
  })
