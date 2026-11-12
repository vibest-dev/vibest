import type { Plugin } from "@vibest/plugin"
import { claudePlugin, piPlugin } from "@vibest/plugin-harnesses"
import { plugin as runtimeHerdrCore } from "@vibest/runtime-herdr-core/plugin"
import { choicePlugin } from "@vibest/runtime-herdr/choice"
import { herdrCommands } from "@vibest/runtime-herdr/commands"
import { plugin as runtimeHerdr } from "@vibest/runtime-herdr/plugin"
import type { Effect } from "effect"

import { agentPlugin } from "./agent.ts"
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

export const pre: ReadonlyArray<Builtin> = [
  builtin(agentPlugin),
  builtin(piPlugin),
  builtin(claudePlugin),
  builtin(runtimeHerdrCore),
  builtin(runtimeHerdr),
  builtin(choicePlugin()),
  builtin(harnessDefaultPlugin()),
]

export const commands = <E, R>(refuseAgent: (command: string) => Effect.Effect<void, E, R>) => [
  herdrCommands(refuseAgent),
]
