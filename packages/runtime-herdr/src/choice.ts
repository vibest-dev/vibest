// The builtin runtime choice (runtime-port.md §4): the parent's runtime when it is online on the chosen machine
// (the subagent opens beside its parent), else the configured `runtime` (vibest.json's top-level `runtime` key — the
// product reads its own configuration and hands it in, so this module stays self-contained), else herdr, else the only
// runtime online. Ships with the herdr product (it names herdr); core checks after the chain that whatever it chose is
// online, and refuses with the reason when it is not.
import * as VibestPlugin from "@vibest/plugin"
import { Effect } from "effect"

/** The configured `runtime` key, as the host product reads it (no failure, no context): undefined when none is configured or it cannot be read. */
export type ConfiguredRuntime = () => Effect.Effect<string | undefined>

/** No configured runtime: the chain goes straight to herdr / the only runtime online. */
const none: ConfiguredRuntime = () => Effect.succeed(undefined)

export const choicePlugin = (configured: ConfiguredRuntime = none): VibestPlugin.Plugin.Plugin =>
  VibestPlugin.Plugin.define({
    id: "runtime-choice",
    effect: (context) =>
      context.agent.hook("start.before", (event) =>
        Effect.gen(function* () {
          // A caller's or another plugin's choice stands (`vibest --runtime`, a user plugin); core validates it.
          if (event.runtime !== undefined) return
          const runtimes = event.machines.find((m) => m.machine === event.machine.id)?.runtimes ?? []
          const online = runtimes.filter((r) => r.status === "online")
          if (event.parentRuntime !== undefined && online.some((r) => r.kind === event.parentRuntime)) {
            event.runtime = event.parentRuntime
            return
          }
          // Read per start, so a config edit applies to the next one (the key is read from vibest.json each time).
          const wanted = yield* configured()
          if (wanted !== undefined && online.some((r) => r.kind === wanted)) {
            event.runtime = wanted
            return
          }
          const herdr = online.find((r) => r.kind === "herdr")
          if (herdr !== undefined) {
            event.runtime = herdr.kind
            return
          }
          if (online.length === 1) event.runtime = online[0]!.kind
          // None online, or several without herdr: left unset; core's check after the chain refuses, listing each runtime and why.
        }),
      ),
  })
