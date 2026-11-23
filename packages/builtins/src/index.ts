import { agyPlugin, claudePlugin, cursorPlugin, piPlugin } from "@vibest/plugin-harnesses"
import idleStop from "@vibest/plugin-idle-stop"
import reportReminder from "@vibest/plugin-report-reminder"
import type { Plugin } from "@vibest/plugin/effect"
import { plugin as runtimeHerdrCore } from "@vibest/runtime-herdr-core/plugin"
import { herdrCommands } from "@vibest/runtime-herdr/commands"
import { plugin as runtimeHerdr } from "@vibest/runtime-herdr/plugin"
import { plugin as runtimeRex } from "@vibest/runtime-rex/plugin"
import { Effect, FileSystem, Path, Predicate, type Schema } from "effect"

import { agentFilesPlugin } from "./agent-files.ts"
import { agentPlugin } from "./agent.ts"
import { harnessDefaultPlugin } from "./harness-default.ts"
import { runtimeChoicePlugin } from "./runtime-choice.ts"

export interface Builtin {
  readonly source: string
  readonly revision: string
  readonly options: Schema.JsonObject
  readonly plugin: Plugin.Plugin
  readonly optional?: boolean
  readonly revise?: Effect.Effect<{ readonly revision: string; readonly plugin: Plugin.Plugin }>
}

const builtin = (plugin: Plugin.Plugin): Builtin => ({
  source: `builtin:${plugin.id}`,
  revision: plugin.id,
  options: {},
  plugin,
})

const savedHarness = (home: string, parseJsonc: (text: string) => Schema.Json) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const config = path.join(home, "vibest.json")

    return fs.readFileString(config).pipe(
      Effect.flatMap((text) => Effect.try(() => parseJsonc(text))),
      Effect.map((raw) => {
        const value = Predicate.hasProperty(raw, "defaultHarness") ? raw.defaultHarness : undefined

        return Predicate.isString(value) && value !== "" ? value : undefined
      }),
      Effect.orElseSucceed(() => undefined),
    )
  })

export const pre = (home: string, parseJsonc: (text: string) => Schema.Json) =>
  Effect.gen(function* () {
    const pi = yield* piPlugin
    const claude = yield* claudePlugin
    const cursor = yield* cursorPlugin
    const agy = yield* agyPlugin
    const agentFiles = yield* agentFilesPlugin(home)
    const defaultHarness = yield* savedHarness(home, parseJsonc)

    return [
      builtin(agentPlugin),
      builtin(pi),
      builtin(claude),
      builtin(cursor),
      builtin(agy),
      builtin(runtimeHerdrCore),
      builtin(runtimeHerdr),
      builtin(runtimeRex),
      builtin(runtimeChoicePlugin()),
      builtin(harnessDefaultPlugin(defaultHarness)),
      { ...builtin(agentFiles.plugin), revise: agentFiles.revise },
      { ...builtin(reportReminder), optional: true },
      { ...builtin(idleStop), optional: true },
    ]
  })

export const commands = <E, R>(
  refuseAgent: (command: string) => Effect.Effect<void, E, R>,
  clients: Parameters<typeof herdrCommands>[1],
) => [herdrCommands(refuseAgent, clients)]
