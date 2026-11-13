import { capture } from "@vibest/plugin"
import { Effect } from "effect"
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner"

export type Spawner = ChildProcessSpawner.ChildProcessSpawner["Service"]

export const record = (u: unknown): Record<string, unknown> | undefined =>
  typeof u === "object" && u !== null && !Array.isArray(u) ? (u as Record<string, unknown>) : undefined

export const CLI_TIMEOUT = "10 seconds"

export const parseJson = (text: string | undefined): unknown => {
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

export { claudeAccount } from "./claude.ts"
export { cursorAccount } from "./cursor.ts"
export { piAccount } from "./pi.ts"
