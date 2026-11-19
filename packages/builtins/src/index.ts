import { agyPlugin, claudePlugin, cursorPlugin, piPlugin } from "@vibest/plugin-harnesses"
import idleStop from "@vibest/plugin-idle-stop"
import reportReminder from "@vibest/plugin-report-reminder"
import type { Plugin } from "@vibest/plugin/effect"
import { plugin as runtimeHerdrCore } from "@vibest/runtime-herdr-core/plugin"
import { choicePlugin } from "@vibest/runtime-herdr/choice"
import { herdrCommands } from "@vibest/runtime-herdr/commands"
import { plugin as runtimeHerdr } from "@vibest/runtime-herdr/plugin"
import { Effect, type Schema } from "effect"

import { agentPlugin } from "./agent.ts"
import { archiveOnIdlePlugin } from "./archive-on-idle.ts"
import { harnessDefaultPlugin } from "./harness-default.ts"

export interface Builtin {
  readonly source: string
  readonly revision: string
  readonly options: Schema.JsonObject
  readonly plugin: Plugin.Plugin
  readonly optional?: boolean
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
  const cursor = yield* cursorPlugin
  const agy = yield* agyPlugin
  const archiveOnIdle = yield* archiveOnIdlePlugin

  return [
    builtin(agentPlugin),
    builtin(pi),
    builtin(claude),
    builtin(cursor),
    builtin(agy),
    builtin(runtimeHerdrCore),
    builtin(runtimeHerdr),
    builtin(choicePlugin()),
    builtin(archiveOnIdle),
    builtin(harnessDefaultPlugin()),
    { ...builtin(reportReminder), optional: true },
    { ...builtin(idleStop), optional: true },
  ]
})

export const commands = <E, R>(
  refuseAgent: (command: string) => Effect.Effect<void, E, R>,
  clients: Parameters<typeof herdrCommands>[1],
) => [herdrCommands(refuseAgent, clients)]
