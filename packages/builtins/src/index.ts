import { claudePlugin, piPlugin } from "@vibest/plugin-harnesses"
import type { Plugin } from "@vibest/plugin/effect"
import { plugin as runtimeHerdrCore } from "@vibest/runtime-herdr-core/plugin"
import { choicePlugin } from "@vibest/runtime-herdr/choice"
import { herdrCommands } from "@vibest/runtime-herdr/commands"
import { plugin as runtimeHerdr } from "@vibest/runtime-herdr/plugin"
import { Effect } from "effect"

import { agentPlugin } from "./agent.ts"
import { archiveOnIdlePlugin } from "./archive-on-idle.ts"
import { harnessDefaultPlugin } from "./harness-default.ts"

export interface Builtin {
  readonly source: string
  readonly revision: string
  readonly options: Readonly<Record<string, unknown>>
  readonly plugin: Plugin.Plugin
}

const builtin = (plugin: Plugin.Plugin): Builtin => ({
  source: `builtin:${plugin.id}`,
  revision: plugin.id,
  options: {},
  plugin,
})

export const pre = Effect.gen(function* () {
  const pi = yield* piPlugin
  const claude = yield* claudePlugin
  const archiveOnIdle = yield* archiveOnIdlePlugin
  return [
    builtin(agentPlugin),
    builtin(pi),
    builtin(claude),
    builtin(runtimeHerdrCore),
    builtin(runtimeHerdr),
    builtin(choicePlugin()),
    builtin(archiveOnIdle),
    builtin(harnessDefaultPlugin()),
  ]
})

export const commands = <E, R>(
  refuseAgent: (command: string) => Effect.Effect<void, E, R>,
  clients: Parameters<typeof herdrCommands>[1],
) => [herdrCommands(refuseAgent, clients)]
