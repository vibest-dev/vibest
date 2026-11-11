import { Plugin } from "@vibest/plugin"
import { Effect } from "effect"

export default Plugin.define({
  id: "glm-only",
  effect: (context) =>
    Effect.gen(function* () {
      const provider = typeof context.options.provider === "string" ? context.options.provider : undefined
      const model = typeof context.options.model === "string" ? context.options.model : undefined
      if (provider === undefined && model === undefined) return
      yield* context.agent.hook("start.before", (event) =>
        Effect.succeed(
          event.agentType === "main"
            ? undefined
            : {
                harness: "pi",
                ...(provider === undefined ? {} : { provider }),
                ...(model === undefined ? {} : { model }),
              },
        ),
      )
    }),
})
