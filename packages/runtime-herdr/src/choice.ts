import * as VibestPlugin from "@vibest/plugin"
import { Effect } from "effect"

export type ConfiguredRuntime = () => Effect.Effect<string | undefined>

const none: ConfiguredRuntime = () => Effect.succeed(undefined)

export const choicePlugin = (configured: ConfiguredRuntime = none): VibestPlugin.Plugin.Plugin =>
  VibestPlugin.Plugin.define({
    id: "runtime-choice",
    effect: (context) =>
      context.agent.hook("start.before", (event) =>
        Effect.gen(function* () {
          if (event.runtime !== undefined) return
          const runtimes = event.machines.find((m) => m.machine === event.machine.id)?.runtimes ?? []
          const online = runtimes.filter((r) => r.status === "online")
          const wanted = (yield* configured()) ?? event.parentRuntime
          if (wanted !== undefined) {
            event.runtime = wanted
            return
          }
          const herdr = online.find((r) => r.kind === "herdr")
          if (herdr !== undefined) {
            event.runtime = herdr.kind
            return
          }
          if (online.length === 1) event.runtime = online[0]!.kind
        }),
      ),
  })
