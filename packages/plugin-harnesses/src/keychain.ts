import { capture } from "@vibest/plugin"
import { Context, Effect, FileSystem, Layer } from "effect"
import type { ChildProcessSpawner } from "effect/process"

const CLI_TIMEOUT = "10 seconds"

export const CLAUDE_CREDENTIALS = "Claude Code-credentials"
export const CURSOR_ACCESS_TOKEN = "cursor-access-token"

export const securityArgs = (service: string) => ["security", "find-generic-password", "-s", service, "-w"] as const

export const claudeCredentialsFile = (home: string) => `${home}/.claude/.credentials.json`

const security = (service: string) => {
  const [command, ...args] = securityArgs(service)
  return capture(command, args, { stdin: "ignore", timeout: CLI_TIMEOUT }).pipe(
    Effect.map((run) => {
      if (run === undefined || run.exitCode !== 0) return undefined
      const value = run.stdout.replace(/\n$/, "")
      return value === "" ? undefined : value
    }),
    Effect.orElseSucceed(() => undefined),
  )
}

const read = (
  service: string,
  home: string,
): Effect.Effect<string | undefined, never, FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner> =>
  process.platform === "darwin"
    ? security(service)
    : service === CLAUDE_CREDENTIALS && home
      ? Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(claudeCredentialsFile(home))).pipe(
          Effect.orElseSucceed(() => undefined),
        )
      : Effect.succeed(undefined)

export class Secrets extends Context.Service<
  Secrets,
  { readonly password: (service: string, home: string) => Effect.Effect<string | undefined> }
>()("vibest/plugin-harnesses/Secrets") {
  static readonly layer = Layer.effect(
    Secrets,
    Effect.map(Effect.context<FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner>(), (context) => ({
      password: (service: string, home: string) => read(service, home).pipe(Effect.provide(context)),
    })),
  )
}

export const password = (service: string, home: string) =>
  Effect.gen(function* () {
    return yield* (yield* Secrets).password(service, home)
  })
