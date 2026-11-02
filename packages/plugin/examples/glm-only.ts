// A routing plugin: every subagent runs on Pi with one provider and model, whatever the main agent asked for.
// The main agent itself is left alone. Options: { "provider": "…", "model": "…" }.
//
//   { "plugins": [{ "package": "./routers/glm-only.ts", "options": { "provider": "zai", "model": "glm-5.3" } }] }
//
// The path is relative to VIBEST_HOME. Keep it out of `plugins/`: files there load on their own, without options.
import { Plugin } from "@vibest/plugin"
import { Effect } from "effect"

export default Plugin.define({
  id: "glm-only",
  effect: (context) =>
    Effect.gen(function* () {
      const provider = typeof context.options.provider === "string" ? context.options.provider : undefined
      const model = typeof context.options.model === "string" ? context.options.model : undefined
      // Without options it routes nothing: forcing Pi alone would keep a model meant for another harness.
      if (provider === undefined && model === undefined) return
      yield* context.agent.hook("start.before", (event) =>
        Effect.sync(() => {
          if (event.agentType === "main") return
          event.harness = "pi"
          if (provider !== undefined) event.provider = provider
          if (model !== undefined) event.model = model
        }),
      )
    }),
})
