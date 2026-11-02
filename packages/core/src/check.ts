// The builtin `check` rule (architecture.md §4.3). Off until configured: `{ "package": "check", "options": { "command", "attempts" } }`.
import { Plugin, type AgentIdle } from "@vibest/plugin"
import { Duration, Effect, Option, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

/** A check command that has not finished by then is a failure. */
export const CHECK_TIMEOUT = Duration.minutes(10)
const TAIL_LINES = 30
/** One line past this is cut, so a single huge line cannot sit in the daemon. */
const LINE_CAP = 4096

const tailOf = (text: string) => text.trim().split("\n").slice(-TAIL_LINES).join("\n").trim()

interface TailState {
  readonly lines: ReadonlyArray<string>
  readonly partial: string
}

const emptyTail: TailState = { lines: [], partial: "" }

/** Last `TAIL_LINES` lines. `partial` is the current line, already cut at `LINE_CAP`. */
const pushTail = (state: TailState, chunk: string): TailState => {
  let lines = state.lines
  let partial = state.partial
  let at = 0
  while (at < chunk.length) {
    const nl = chunk.indexOf("\n", at)
    const end = nl === -1 ? chunk.length : nl
    const room = LINE_CAP - partial.length
    if (room > 0) partial += chunk.slice(at, Math.min(end, at + room))
    if (nl === -1) break
    lines = lines.length === TAIL_LINES ? [...lines.slice(1), partial] : [...lines, partial]
    partial = ""
    at = nl + 1
  }
  return { lines, partial }
}

const tailText = (state: TailState) => {
  const lines = state.partial.length > 0
    ? state.lines.length === TAIL_LINES ? [...state.lines.slice(1), state.partial] : [...state.lines, state.partial]
    : state.lines
  return lines.join("\n")
}

/** Fold the stream. Never `Stream.mkString` the whole output. */
const readTail = <E, R>(stream: Stream.Stream<Uint8Array, E, R>) =>
  Stream.decodeText(stream).pipe(Stream.runFold(() => emptyTail, pushTail), Effect.map(tailText))

const attemptsOf = (options: Readonly<Record<string, unknown>>) => {
  const raw = options.attempts
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 1
}

/**
 * Run `command` in `cwd`. The shell is its own process group; a timeout or an interrupt closes this scope.
 * The spawner already signals that group and SIGKILLs it after `forceKillAfter` (`NodeChildProcessSpawner.terminateProcessGroup`).
 * `timeout` defaults to `CHECK_TIMEOUT`.
 */
export const runCheck = (command: string, cwd: string, timeout = CHECK_TIMEOUT) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    // shortcut: vibestd dying mid-command orphans the group, the next check runs that attempt again.
    const handle = yield* spawner.spawn(
      ChildProcess.make("sh", ["-c", command], { cwd, stdin: "ignore", detached: true, forceKillAfter: "1 second" }),
    )
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [readTail(handle.stdout), readTail(handle.stderr), handle.exitCode],
      { concurrency: "unbounded" },
    )
    const text = tailOf(`${stdout}\n${stderr}`)
    return { ok: exitCode === 0, tail: text.length > 0 ? text : exitCode === 0 ? "ok" : "check failed" }
  }).pipe(
    Effect.scoped,
    Effect.timeoutOption(timeout),
    Effect.map((done) => (Option.isSome(done) ? done.value : { ok: false, tail: "check timed out" })),
    Effect.catch((error) => Effect.succeed({ ok: false, tail: tailOf(error instanceof Error ? error.message : String(error)) || "check failed" })),
  )

export const checkPlugin = Plugin.define({
  id: "check",
  effect: (context) => Effect.gen(function* () {
    const command = typeof context.options.command === "string" ? context.options.command.trim() : ""
    if (command === "") return yield* Effect.die(new Error("check: command is empty"))
    const limit = attemptsOf(context.options)
    const onIdle = (event: AgentIdle) => Effect.sync(() => {
      if (event.agentType === "main" || event.directory === "") return
      if (event.ran === undefined) {
        event.command = command
        return
      }
      if (event.ran.ok) return
      if (event.checkAttempts < limit) event.prompt = event.ran.tail
      else event.output = event.ran.tail
    })
    yield* context.agent.hook("idle", onIdle)
  }),
})
