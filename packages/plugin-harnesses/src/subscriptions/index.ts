import { Host } from "@vibest/plugin/host"
import { Effect, Schema } from "effect"
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner"

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
  Host.capture(command, args, {
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

export { claudeAccount } from "./claude.ts"

export { cursorAccount } from "./cursor.ts"

export { piAccount } from "./pi.ts"
