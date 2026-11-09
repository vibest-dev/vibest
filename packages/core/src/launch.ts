import { Config, Effect, FileSystem, Option } from "effect"

import { COORDINATOR } from "./guard.ts"
import { encodeCommand, Harness, Harnesses, HarnessUnavailable, type HarnessId } from "./harness.ts"
import { Layout, VibestCommand } from "./paths.ts"
import { type Machine, type Runtime } from "./runtimes.ts"
import { LaunchFailed } from "./sessions.ts"
import {
  coordinatorSystemPrompt,
  projectText,
  SystemPromptDirUnsafe,
  systemPromptRoot,
  writeSystemPrompt,
} from "./system-prompt.ts"

const unsafeOnly = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.catch((e) => (e instanceof SystemPromptDirUnsafe ? Effect.fail(e) : Effect.die(e))))

export const coordinatorCommand = Effect.fn("coordinatorCommand")(function* <E, R>(input: {
  readonly harness: HarnessId
  readonly root: string
  readonly provider: string | null
  readonly model: string | null
  readonly passEnv: ReadonlyArray<string>
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
  const adapter = (yield* Harnesses).get(input.harness)
  const harness = yield* Harness
  const layout = yield* Layout
  const vibest = yield* VibestCommand
  const unavailable = (message: string) => new HarnessUnavailable({ harness: input.harness, message })
  if (!adapter.coordinatorArgs)
    return yield* unavailable(`${input.harness} is not currently supported as the coordinator`)
  const providerError = adapter.checkProvider(input.provider)
  if (providerError) return yield* unavailable(providerError)
  if (!(yield* harness.available(input.harness))) return yield* unavailable(`${adapter.binary} is not on PATH`)
  const pluginDir = yield* harness.plugin(input.harness)
  yield* unsafeOnly(systemPromptRoot)
  const env: Record<string, string> = {
    VIBEST_AGENT: COORDINATOR,
    VIBEST_HARNESS: input.harness,
    VIBEST_HOME: layout.home,
    VIBEST_COMMAND: encodeCommand(vibest),
  }
  for (const name of input.passEnv) {
    const value = yield* Config.option(Config.String(name))
    if (Option.isSome(value)) env[name] = value.value
  }
  const saved = yield* input.session
  const systemPromptFile = yield* unsafeOnly(
    writeSystemPrompt(
      saved.sessionId,
      coordinatorSystemPrompt({
        projectDir: layout.project(saved.projectId),
        ...(yield* projectText(layout.project(saved.projectId))),
      }),
    ),
  )
  yield* (yield* FileSystem.FileSystem)
    .makeDirectory(layout.artifacts(saved.projectId), { recursive: true })
    .pipe(Effect.ignore)
  let harnessSessionId = saved.harnessSessionId
  if (harnessSessionId !== null && adapter.canResume && !(yield* adapter.canResume(input.root, harnessSessionId)))
    harnessSessionId = null
  const commandEnv: Record<string, string> = {
    ...env,
    VIBEST_SESSION_ID: saved.sessionId,
    VIBEST_PROJECT_ID: saved.projectId,
    VIBEST_PROJECT_DIR: layout.project(saved.projectId),
    ...(saved.runtime !== undefined ? { VIBEST_RUNTIME: saved.runtime } : {}),
  }
  return {
    file: adapter.binary,
    args: adapter.coordinatorArgs({
      root: input.root,
      projectDir: layout.project(saved.projectId),
      systemPromptFile,
      provider: input.provider,
      model: input.model,
      sessionId: harnessSessionId,
      pluginDir,
      env: commandEnv,
    }),
    env: commandEnv,
  }
})

export const IDENTITY_ENV = [
  "VIBEST_SESSION_ID",
  "VIBEST_PROJECT_ID",
  "VIBEST_PROJECT_DIR",
  "VIBEST_AGENT",
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

export const inParent = (argv: ReadonlyArray<string>, root: string, runtime: string) => {
  const rest: Array<string> = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--runtime") i++
    else if (!argv[i]!.startsWith("--runtime=")) rest.push(argv[i]!)
  }
  return [...rest, "--runtime", runtime, "--in-parent", root]
}

export const openInParentWorkspace = Effect.fn("Launch.openInParentWorkspace")(function* (
  h: Runtime,
  machine: Machine,
  input: {
    readonly root: string
    readonly label: string
    readonly home: string
    readonly env?: Readonly<Record<string, string>> | undefined
    readonly focus?: boolean | undefined
  },
) {
  const terminal = yield* h
    .open(machine, {
      project: input.root,
      cwd: input.root,
      argv: ["sh", "-c", '"$@"; exec "${SHELL:-/bin/sh}"', "sh"],
      env: { ...input.env, VIBEST_HOME: input.home },
      label: input.label,
      ...(input.focus === true ? { focus: true } : {}),
    })
    .pipe(Effect.mapError((e) => new LaunchFailed({ message: e.message })))
  return terminal
})
