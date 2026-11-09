import { Context, Effect, FileSystem, Layer, Option, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

const CLI_TIMEOUT = "10 seconds"

export const CLAUDE_CREDENTIALS = "Claude Code-credentials"
export const CURSOR_ACCESS_TOKEN = "cursor-access-token"

export const securityArgs = (service: string) => ["security", "find-generic-password", "-s", service, "-w"] as const

export const claudeCredentialsFile = (home: string) => `${home}/.claude/.credentials.json`

const security = (service: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const [command, ...args] = securityArgs(service)
    const handle = yield* spawner.spawn(ChildProcess.make(command, args, { stdin: "ignore" }))
    const [text, , code] = yield* Effect.all(
      [Stream.mkString(Stream.decodeText(handle.stdout)), Stream.runDrain(handle.stderr), handle.exitCode],
      { concurrency: "unbounded" },
    )
    const value = text.replace(/\n$/, "")
    return code === 0 && value !== "" ? value : undefined
  }).pipe(
    Effect.scoped,
    Effect.timeoutOption(CLI_TIMEOUT),
    Effect.map(Option.getOrUndefined),
    Effect.orElseSucceed(() => undefined),
  )

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
