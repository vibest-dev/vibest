import { Plugin } from "@vibest/plugin/effect"
import { Effect } from "effect"

export const DEFAULT_HARNESS = "claude"

export const harnessDefaultPlugin = () =>
  Plugin.define({
    id: "harness-default",
    effect: (context) =>
      context.agent.hook("start.before", (event) =>
        Effect.succeed(
          event.harness === undefined && event.harnesses.some((h) => h.harness === DEFAULT_HARNESS && h.available)
            ? { harness: DEFAULT_HARNESS }
            : undefined,
        ),
      ),
  })
