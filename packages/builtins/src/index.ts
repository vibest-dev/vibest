import type { Plugin } from "@vibest/plugin"
import { claude, claudePlugin, cursor, cursorPlugin, pi, piPlugin } from "@vibest/plugin-harnesses"
import { plugin as runtimeHerdrCore } from "@vibest/runtime-herdr-core/plugin"
import { KIND as hcKind } from "@vibest/runtime-herdr-core/terminal-runtime"
import { choicePlugin } from "@vibest/runtime-herdr/choice"
import { herdrCommands } from "@vibest/runtime-herdr/commands"
import { plugin as runtimeHerdr } from "@vibest/runtime-herdr/plugin"
import { KIND as herdrKind } from "@vibest/runtime-herdr/terminal-runtime"
import type { Effect } from "effect"

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

export const harnesses = [
  { definition: pi, plugin: piPlugin },
  { definition: claude, plugin: claudePlugin },
  { definition: cursor, plugin: cursorPlugin },
] as const

export const runtimes = [
  { id: hcKind, plugin: runtimeHerdrCore },
  { id: herdrKind, plugin: runtimeHerdr },
] as const

export const pre: ReadonlyArray<Builtin> = [
  ...harnesses.map((entry) => builtin(entry.plugin)),
  ...runtimes.map((entry) => builtin(entry.plugin)),
  builtin(choicePlugin()),
]

export const commands = <E, R>(refuseAgent: (command: string) => Effect.Effect<void, E, R>) => [
  herdrCommands(refuseAgent),
]
