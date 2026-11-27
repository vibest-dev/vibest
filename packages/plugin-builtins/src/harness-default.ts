import { Plugin } from "@vibest/plugin/effect"
import { Effect } from "effect"

export const DEFAULT_HARNESS = "claude"

export const harnessDefaultPlugin = (configured: Effect.Effect<string | undefined> = Effect.undefined) =>
  Plugin.define({
    id: "vibest.harness-default",
    effect: (context) =>
      context.session.hook("start.before", (event) =>
        Effect.gen(function* () {
          if (event.harness !== undefined) return

          const available = (harness: string | undefined) =>
            event.harnesses.some((h) => h.harness === harness && h.available)

          const saved = yield* configured

          if (available(saved)) event.harness = saved
          else if (available(DEFAULT_HARNESS)) event.harness = DEFAULT_HARNESS
        }),
      ),
  })
