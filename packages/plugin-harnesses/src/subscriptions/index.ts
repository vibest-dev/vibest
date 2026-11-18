import { capture } from "@vibest/plugin/effect"
import { Effect, Schema } from "effect"
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner"

import { nodePlatform } from "../node-platform.ts"

export type Spawner = ChildProcessSpawner.ChildProcessSpawner["Service"]

const isJsonObject = Schema.is(Schema.JsonObject)

export const record = (u: Schema.Json | undefined): Schema.JsonObject | undefined => (isJsonObject(u) ? u : undefined)

export const CLI_TIMEOUT = "10 seconds"

export const parseJson = (text: string | undefined): Schema.Json | undefined => {
  if (text === undefined || text.trim() === "") return undefined

  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export const runCli = (spawner: Spawner, command: string, args: ReadonlyArray<string>, cwd: string) =>
  capture(command, args, {
    stdin: "ignore",
    cwd,
    env: { HOME: cwd },
    extendEnv: true,
    timeout: CLI_TIMEOUT,
  }).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.map((run) => (run === undefined ? undefined : run.stdout)),
    Effect.orElseSucceed(() => undefined),
  )

export const runCliLines = (
  spawner: Spawner,
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
  env: Readonly<Record<string, string>> = {},
) =>
  capture(command, args, {
    stdin: "ignore",
    cwd,
    env: { ...env, HOME: cwd },
    extendEnv: true,
    timeout: CLI_TIMEOUT,
  }).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.map((run) => (run === undefined ? undefined : `${run.stderr}\n${run.stdout}`.split("\n"))),
    Effect.orElseSucceed(() => undefined),
  )

export { claudeAccount } from "./claude.ts"

export { cursorAccount } from "./cursor.ts"

export { piAccount } from "./pi.ts"

export const signInProblem =
  (args: ReadonlyArray<string>, signedIn: (lines: ReadonlyArray<string>) => boolean | undefined) =>
  (home: string, binary: string, env: Readonly<Record<string, string>>) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const lines = yield* runCliLines(spawner, binary, args, home, env)

      return lines !== undefined && signedIn(lines) === false
        ? `${binary} is not signed in; sign in with ${binary}, then run vibest again`
        : undefined
    }).pipe(Effect.provide(nodePlatform))
