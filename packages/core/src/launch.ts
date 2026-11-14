import { Layout, VibestCommand } from "@vibest/schema/layout"
import { LaunchFailed, HarnessUnavailable, type HarnessId } from "@vibest/schema/session"
import { Effect, FileSystem } from "effect"

import { Agents, unknownAgent } from "./agents.ts"
import { encodeCommand, Harness, Harnesses } from "./harness.ts"
import type { AgentsShape } from "./plugin/domains.ts"
import { addressOf, type Runtime } from "./runtimes.ts"
import {
  projectText,
  SystemPromptDirUnsafe,
  systemPrompt,
  systemPromptRoot,
  writeSystemPrompt,
} from "./system-prompt.ts"

export const definitionIn = (agents: AgentsShape, id: string) => {
  const found = agents.find(id)
  return found === undefined ? Effect.fail(unknownAgent(id, agents.all)) : Effect.succeed(found)
}

export const definitionOf = (id: string) => Effect.flatMap(Agents, (agents) => definitionIn(agents, id))

const unsafeOnly = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.catch((e) => (e instanceof SystemPromptDirUnsafe ? Effect.fail(e) : Effect.die(e))))

export const entryCommand = Effect.fn("entryCommand")(function* <E, R>(input: {
  readonly harness: HarnessId
  readonly agent: string
  readonly root: string
  readonly provider: string | null
  readonly model: string | null
  readonly session: Effect.Effect<
    {
      readonly sessionId: string
      readonly harnessSessionId: string | null
      readonly projectId: string
      readonly runtime?: string | undefined
    },
    E,
    R
  >
}) {
  const definition = yield* definitionOf(input.agent)
  const adapter = yield* (yield* Harnesses).get(input.harness)
  const harness = yield* Harness
  const layout = yield* Layout
  const vibest = yield* VibestCommand
  const unavailable = (message: string) => new HarnessUnavailable({ harness: input.harness, message })
  const providerError = adapter.checkProvider?.(input.provider)
  if (providerError) return yield* unavailable(providerError)
  if (!(yield* harness.available(input.harness))) return yield* unavailable(`${adapter.binary} is not on PATH`)
  const pluginDir = yield* harness.plugin(input.harness)
  yield* unsafeOnly(systemPromptRoot)
  const env: Record<string, string> = {
    VIBEST_HARNESS: input.harness,
    VIBEST_HOME: layout.home,
    VIBEST_COMMAND: encodeCommand(vibest),
  }
  const saved = yield* input.session
  const systemPromptFile = yield* unsafeOnly(
    writeSystemPrompt(
      saved.sessionId,
      systemPrompt({
        system: definition.system,
        id: saved.sessionId,
        checkout: true,
        projectDir: layout.project(saved.projectId),
        vibest,
        ...(yield* projectText(layout.project(saved.projectId))),
      }),
    ),
  )
  yield* (yield* FileSystem.FileSystem)
    .makeDirectory(layout.artifacts(saved.projectId), { recursive: true })
    .pipe(Effect.ignore)
  const commandEnv: Record<string, string> = {
    ...env,
    VIBEST_SESSION_ID: saved.sessionId,
    VIBEST_PROJECT_ID: saved.projectId,
    VIBEST_PROJECT_DIR: layout.project(saved.projectId),
    ...(saved.runtime !== undefined ? { VIBEST_RUNTIME: saved.runtime } : {}),
  }
  return {
    file: adapter.binary,
    args: adapter.launchArgs({
      worktree: input.root,
      projectDir: layout.project(saved.projectId),
      systemPromptFile,
      provider: input.provider,
      model: input.model,
      sessionId: saved.harnessSessionId,
      resume: saved.harnessSessionId !== null,
      pluginDir,
      vibest,
      env: commandEnv,
    }),
    env: commandEnv,
  }
})

export const IDENTITY_ENV = [
  "VIBEST_SESSION_ID",
  "VIBEST_PROJECT_ID",
  "VIBEST_PROJECT_DIR",
  "VIBEST_HARNESS",
  "VIBEST_RUNTIME",
  "VIBEST_HOME",
  "VIBEST_COMMAND",
] as const

export const identityPairs = (env: Readonly<Record<string, string>>) =>
  IDENTITY_ENV.flatMap((key) => {
    const value = env[key]
    return value === undefined ? [] : [`${key}=${value}`]
  })

export const restartArgv = (command: {
  readonly file: string
  readonly args: ReadonlyArray<string>
  readonly env: Readonly<Record<string, string>>
}) => ["env", ...identityPairs(command.env), command.file, ...command.args]

export const flagValue = (argv: ReadonlyArray<string>, name: string) => {
  const value = argv[argv.indexOf(name) + 1]
  return argv.includes(name) && value !== undefined && !value.startsWith("-") ? value : undefined
}

export const openInParentWorkspace = Effect.fn("Launch.openInParentWorkspace")(function* (
  h: Runtime,
  target: string | undefined,
  input: {
    readonly root: string
    readonly label: string
    readonly home: string
    readonly env?: Readonly<Record<string, string>> | undefined
    readonly focus?: boolean | undefined
  },
) {
  const terminal = yield* h
    .open({
      project: input.root,
      cwd: input.root,
      argv: ["sh", "-c", '"$@"; exec "${SHELL:-/bin/sh}"', "sh"],
      env: { ...input.env, VIBEST_HOME: input.home },
      label: input.label,
      ...(input.focus === true ? { focus: true } : {}),
      ...(target !== undefined ? { target } : {}),
    })
    .pipe(Effect.mapError((e) => new LaunchFailed({ message: e.message })))
  return addressOf(terminal)
})
