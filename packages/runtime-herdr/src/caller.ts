import { shellQuote } from "@vibest/schema/layout"
import { Config, Duration, Effect, Option, Schema } from "effect"
// What the vibest CLI and the herdr plugin command need to say where they are: the caller's herdr location as
// `Machine.target` (runtime-port.md §2, §4) and the terminal id of the pane it runs in, plus the two pane operations
// `vibest` does in place. Everything herdr-specific about *being* a caller lives here.
import { Herdr, type HerdrShape } from "effect-herdr-sdk"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

import { encodeTarget } from "./terminal-runtime.ts"

/** The caller's location: its own herdr socket inside herdr, otherwise a session name (default vibest). An explicit `--session` wins over the ambient socket. */
export const callerLocation = (named?: string) =>
  Effect.gen(function* () {
    if (named !== undefined) return { session: named }
    const socketPath = Option.getOrUndefined(yield* Config.option(Config.String("HERDR_SOCKET_PATH")))
    return socketPath !== undefined ? { socketPath } : { session: "vibest" }
  })

/** The caller's location as the `Machine` the RPCs carry: local host, the herdr to reach as `target` JSON (§2). */
export const callerMachine = (named?: string) =>
  callerLocation(named).pipe(Effect.map((location) => ({ id: "local", target: encodeTarget(location) })))

/** What `vibest` in a coordinator's shell needs to find its own pane; a harness may hand its shell less than it got. */
export const CALLER_ENV = ["HERDR_PANE_ID", "HERDR_SOCKET_PATH"] as const

const SessionList = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      sessions: Schema.Array(
        Schema.Struct({ name: Schema.String, socket_path: Schema.String, running: Schema.Boolean }),
      ),
    }),
  ),
)

/**
 * The pane this process runs in, as a terminal id (`<session>/<pane>`: pane ids repeat across herdr sessions, so both
 * go in). The session is found by this pane's socket, one local `herdr session list`; undefined outside herdr.
 */
export const callerTerminal = Effect.gen(function* () {
  const paneId = Option.getOrUndefined(yield* Config.option(Config.String("HERDR_PANE_ID")))
  const socketPath = Option.getOrUndefined(yield* Config.option(Config.String("HERDR_SOCKET_PATH")))
  if (paneId === undefined || paneId === "" || socketPath === undefined || socketPath === "") return undefined
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const out = yield* spawner.string(ChildProcess.make("herdr", ["session", "list", "--json"]))
  const list = yield* SessionList(out)
  const session = list.sessions.find((s) => s.socket_path === socketPath)
  return session === undefined ? undefined : `${session.name}/${paneId}`
})

/** How long a shell may take to draw its prompt before the command is typed. */
const SHELL_TIMEOUT = Duration.seconds(10)

/**
 * Have the shell in `paneId` run `argv` at `root`: once it has drawn something (its prompt; input typed earlier can be
 * dropped), type `cd <root> && <argv>` and Enter. A process cannot move its own shell, so this is also how `vibest`
 * below the root gets its own pane's shell there.
 */
export const runAtRoot = (h: HerdrShape, paneId: string, root: string, argv: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    yield* h.call("pane.wait_for_output", {
      pane_id: paneId,
      source: "visible",
      match: { type: "regex", value: "\\S" },
      timeout_ms: Duration.toMillis(SHELL_TIMEOUT),
    })
    const text = `cd ${shellQuote(root)} && ${argv.map(shellQuote).join(" ")}`
    yield* h.call("pane.send_text", { pane_id: paneId, text })
    yield* h.call("pane.send_keys", { pane_id: paneId, keys: ["enter"] })
  })

/** A herdr client on the ambient socket, for the in-place path (verified once; the pane's own server). */
export const ambientHerdr = Effect.gen(function* () {
  const socket = Option.getOrUndefined(yield* Config.option(Config.String("HERDR_SOCKET_PATH")))
  const pane = Option.getOrUndefined(yield* Config.option(Config.String("HERDR_PANE_ID")))
  if (socket === undefined || pane === undefined) return undefined
  const client = yield* Herdr.make(socket)
  yield* Herdr.verifyProtocol(client)
  return { h: client, paneId: pane } as const
})
