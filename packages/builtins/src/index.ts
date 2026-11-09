import type { Plugin } from "@vibest/plugin"
import { claudePlugin, cursorPlugin, piPlugin } from "@vibest/plugin-harnesses"
import { plugin as runtimeHerdrCore } from "@vibest/runtime-herdr-core/plugin"
import { choicePlugin } from "@vibest/runtime-herdr/choice"
import { plugin as runtimeHerdr } from "@vibest/runtime-herdr/plugin"

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
  builtin(piPlugin),
  builtin(claudePlugin),
  builtin(cursorPlugin),
  builtin(runtimeHerdrCore),
  builtin(runtimeHerdr),
  builtin(choicePlugin()),
]
