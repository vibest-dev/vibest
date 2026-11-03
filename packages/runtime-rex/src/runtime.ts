// The Runtime API (runtime-api.ts) on Rex (superlogical.com/rex). Everything Rex-specific lives here and in the plugin.
// Rex is driven through its own `rex` CLI (`rex api call <method>`, `rex events --json`): its control API is a WebSocket
// on the server's socket, and the CLI speaks it for us (one call is ~15 ms). The server is the one `rex` itself picks:
// `REX_SERVER` when set, else the user's local server. A terminal id is `<session id>/<block id>` (block methods need both);
// a project's terminals are windows of one Rex session labeled after it.
// ponytail: local machine only (`rex -S <host>` reaches a remote server; `process` reads child processes with a local pgrep).
import childProcess from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"

import { Runtime as RuntimeApi } from "@vibest/plugin"
import type * as VibestPlugin from "@vibest/plugin"
import { Duration, Effect, Queue, Semaphore, Stream } from "effect"

export type Runtime = VibestPlugin.Runtime.Runtime
export type Terminal = VibestPlugin.Runtime.Terminal
export type RuntimeEvent = VibestPlugin.Runtime.RuntimeEvent
type RuntimeError = VibestPlugin.Runtime.RuntimeError

/** The `runtime.kind` of every row this runtime started. */
export const KIND = "rex"

const SHELL = "com.superlogical.terminal.shell"

export const terminalOf = (session: string, block: string): Terminal => ({
  machine: "local",
  id: `${session}/${block}`,
})

/** The session and block a terminal id names; undefined when it is not one of ours. */
export const parseTerminal = (terminal: Terminal) => {
  const at = terminal.id.indexOf("/")
  if (at <= 0 || at === terminal.id.length - 1) return undefined
  return { session: terminal.id.slice(0, at), block: terminal.id.slice(at + 1) }
}

/** The block this process runs in (Rex sets REX_SESSION and REX_BLOCK in every terminal); undefined outside Rex. */
export const callerTerminal = (env: NodeJS.ProcessEnv = process.env): string | undefined =>
  env["REX_SESSION"] && env["REX_BLOCK"] ? `${env["REX_SESSION"]}/${env["REX_BLOCK"]}` : undefined

/** What `vibest` in the main agent's shell needs to find its own block; a harness may hand its shell less than it got. */
export const CALLER_ENV = ["REX_SESSION", "REX_BLOCK"] as const

const executable = (file: string) => {
  try {
    fs.accessSync(file, fs.constants.X_OK)
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

/** `rex`: REX_BIN_DIR (set inside Rex terminals), PATH, else the CLI inside the macOS app bundle. */
export const findRex = (env: NodeJS.ProcessEnv = process.env): string | undefined => {
  const dirs = [env["REX_BIN_DIR"], ...(env["PATH"] ?? "").split(":")].filter((d): d is string => !!d)
  const bundled = ["Rex", "Rex Beta"].map(
    (app) => `/Applications/${app}.app/Contents/Helpers/Rex Server.rex/Contents/MacOS/rex`,
  )
  return [...dirs.map((d) => path.join(d, "rex")), ...bundled].find(executable)
}

const error = (code: RuntimeError["code"], message: string) => new RuntimeApi.RuntimeError({ code, message })

/** A failed `rex` run as the Runtime API's error: Rex's own `code=` when it printed one. */
export const failure = (stderr: string): RuntimeError => {
  const message = stderr.trim().replace(/^Error: /, "") || "rex failed"
  const code = /\bcode=(\w+)/.exec(message)?.[1]
  if (code === "not_found" || code === "session_not_found") return error("not_found", message)
  if (code === "conflict") return error("busy", message)
  if (code !== undefined) return error("failed", message)
  if (/server is not running|connecting to Rex server|dial unix|connection refused/i.test(message))
    return error("unreachable", message)
  return error("failed", message)
}

/** Bytes for the key names vibest sends (`enter`, `esc`, `ctrl+c`, …). */
const KEYS: Readonly<Record<string, string>> = {
  enter: "\r",
  return: "\r",
  esc: "\x1b",
  escape: "\x1b",
  tab: "\t",
  space: " ",
  backspace: "\x7f",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
}
const keyBytes = (key: string): string | undefined => {
  const name = key.toLowerCase()
  const ctrl = /^ctrl\+([a-z])$/.exec(name)?.[1]
  return ctrl !== undefined ? String.fromCharCode(ctrl.charCodeAt(0) - 96) : KEYS[name]
}

/** Process names that are a shell, which alone at its prompt is not a running program. */
const SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "tcsh", "csh", "nu", "login"])

interface Proc {
  readonly pid: number
  readonly name: string
}
interface ProcessInfo {
  readonly last_exit: { readonly exit_code: number } | null
  readonly child?: Proc | null
  readonly foreground?: Proc | null
}

const sleep = (ms: number) => Effect.sleep(Duration.millis(ms))

export interface Options {
  /** The `rex` binary; found with `findRex` when absent. */
  readonly bin?: string
  /** A server address for `rex -S`; absent, `rex` picks its own (REX_SERVER, else the user's local server). */
  readonly server?: string
  /** How long `open` waits for a new terminal's program to draw and settle (default 20 s). */
  readonly settle?: Duration.Input
}

/**
 * The Rex Runtime: `open` is a window (or a split beside `near`) in the project's Rex session running argv through
 * `/usr/bin/env K=V` (Rex has no env option), `send` pastes and types, `read` is the screen, `process` the block's
 * program. Optional members: `events` (`rex events --all`), `present` (block labels), `exec` (a detached block).
 * No `state`: agent state comes from vibest's harness integrations.
 */
export const make = (options: Options = {}): Effect.Effect<Runtime> =>
  Effect.gen(function* () {
    const settleFor = Duration.toMillis(Duration.fromInputUnsafe(options.settle ?? "20 seconds"))
    let found = options.bin
    const bin = () => (found ??= findRex())
    const prefix = () => [...(options.server !== undefined ? ["-S", options.server] : []), "--autostart=false"]

    /** One `rex` run: its stdout, or the error it printed. */
    const rex = (args: ReadonlyArray<string>, input?: string) =>
      Effect.callback<string, RuntimeError>((resume) => {
        const file = bin()
        if (file === undefined) {
          resume(Effect.fail(error("incompatible", "Rex is not installed: no rex on PATH or in /Applications")))
          return
        }
        const child = childProcess.execFile(
          file,
          [...prefix(), ...args],
          { maxBuffer: 64 * 1024 * 1024, timeout: 30_000 },
          (e, stdout, stderr) =>
            resume(e === null ? Effect.succeed(stdout) : Effect.fail(failure(stderr || e.message))),
        )
        child.stdin?.end(input ?? "")
        return Effect.sync(() => child.kill())
      })

    /** A control API call; params go on stdin, so a long prompt never meets the argv limit. */
    const call = <A = Record<string, unknown>>(method: string, params: Record<string, unknown>) =>
      rex(["api", "call", method, "-"], JSON.stringify(params)).pipe(
        Effect.map((out) => (out.trim() === "" ? {} : JSON.parse(out)) as A),
      )

    const at = (terminal: Terminal) => {
      const place = parseTerminal(terminal)
      return place === undefined
        ? Effect.fail(error("not_found", `${terminal.id} is not a Rex terminal`))
        : Effect.succeed(place)
    }
    const method = <A>(terminal: Terminal, name: string, args: Record<string, unknown> = {}) =>
      Effect.flatMap(at(terminal), (place) =>
        call<A>("block.method", { session_id: place.session, block_id: place.block, method: name, args }),
      )

    const local = (machine: VibestPlugin.Runtime.Machine) =>
      machine.id === "local" ? Effect.void : Effect.fail(error("incompatible", "Rex runs on the local machine only"))

    const status: Runtime["status"] = (machine) =>
      machine.id !== "local"
        ? Effect.succeed({ status: "blocked" as const, reason: "Rex runs on the local machine only" })
        : bin() === undefined
          ? Effect.succeed({
              status: "blocked" as const,
              reason: "Rex is not installed: no rex on PATH or in /Applications",
            })
          : call("server.status", {}).pipe(
              Effect.as({ status: "online" as const }),
              Effect.catch((e) =>
                Effect.succeed({
                  status: "blocked" as const,
                  reason: `the Rex server is not running; open Rex (${e.message})`,
                }),
              ),
            )

    // One Rex session per project, found again by its label after a vibestd restart; one lock so two opens make one.
    const sessions = new Map<string, string>()
    const lock = yield* Semaphore.make(1)
    const labelOf = (project: string) => `vibest ${path.basename(project)}`.slice(0, 128)
    const sessionFor = (project: string) =>
      lock.withPermit(
        Effect.gen(function* () {
          const listed = yield* call<{ sessions: ReadonlyArray<{ session_id: string; label?: string }> }>(
            "session.list",
            {},
          )
          const known = sessions.get(project)
          if (known !== undefined && listed.sessions.some((s) => s.session_id === known)) return known
          const label = labelOf(project)
          const id =
            listed.sessions.find((s) => s.label === label)?.session_id ??
            (yield* call<{ session_id: string }>("session.create", { label })).session_id
          sessions.set(project, id)
          return id
        }),
      )

    /** Whether each terminal's program ran when last read: only terminals read before are followed for `exited`. */
    const lastRunning = new Map<string, boolean>()

    const processOf: Runtime["process"] = (terminal) =>
      Effect.gen(function* () {
        const info = yield* method<ProcessInfo>(terminal, "process")
        const fg = info.foreground
        const code = info.last_exit?.exit_code
        const result =
          info.last_exit !== null
            ? code !== undefined && code >= 0
              ? { running: false, exitCode: code }
              : { running: false }
            : // A shell alone at its prompt (the main agent's shell after its harness exited) is not a running program.
              fg && info.child && fg.pid === info.child.pid && SHELLS.has(fg.name.replace(/^-/, ""))
              ? { running: yield* hasChildren(fg.pid) }
              : { running: true }
        lastRunning.set(terminal.id, result.running)
        return result
      })

    /** Wait until a new terminal's program has drawn and its screen stopped changing (or it ended), so text sent next
     * reaches a program that reads it: without `state`, core takes `open` returning as ready (§5). */
    const settle = (terminal: Terminal) =>
      Effect.gen(function* () {
        const deadline = Date.now() + settleFor
        let last = ""
        while (Date.now() < deadline) {
          yield* sleep(300)
          const p = yield* processOf(terminal).pipe(Effect.option)
          if (p._tag === "None" || p.value.exitCode !== undefined) return
          const screen = (yield* read(terminal, 200).pipe(Effect.orElseSucceed(() => ""))).trim()
          if (screen !== "" && screen === last) return
          last = screen
        }
      })

    const open: Runtime["open"] = (machine, input) =>
      Effect.gen(function* () {
        yield* local(machine)
        const env = Object.entries(input.env).map(([k, v]) => `${k}=${v}`)
        const block = {
          flavor: SHELL,
          label: input.label.slice(0, 128),
          options: { command: [...(env.length > 0 ? ["/usr/bin/env", ...env] : []), ...input.argv], cwd: input.cwd },
        }
        const focus = input.focus === true
        const window = (session: string) =>
          call<{ block_ids: ReadonlyArray<string> }>("session.new_window", {
            session_id: session,
            focus,
            window_label: block.label,
            layout: { block },
          }).pipe(Effect.map((r) => terminalOf(session, r.block_ids[0]!)))
        const near = input.near !== undefined ? parseTerminal(input.near) : undefined
        // Beside `near` while it is still there: a split for --peer, else a window of its own in near's session.
        const besideNear =
          near === undefined
            ? Effect.succeed(undefined)
            : (input.split === true
                ? call<{ block_ids: ReadonlyArray<string> }>("session.new_split", {
                    session_id: near.session,
                    anchor_id: near.block,
                    direction: "horizontal",
                    side: "after",
                    focus,
                    layout: { block },
                  }).pipe(Effect.map((r) => terminalOf(near.session, r.block_ids[0]!)))
                : window(near.session)
              ).pipe(
                Effect.catchTag("RuntimeError", (e) =>
                  e.code === "not_found" ? Effect.succeed(undefined) : Effect.fail(e),
                ),
              )
        const terminal = (yield* besideNear) ?? (yield* window(yield* sessionFor(input.project)))
        yield* settle(terminal)
        return terminal
      })

    /** Text alone is a prompt: pasted, then Enter, as herdr's agent.prompt submits. With keys, the keys it names follow. */
    const send: Runtime["send"] = (terminal, { text, keys }) =>
      Effect.gen(function* () {
        const place = yield* at(terminal)
        const pressed = keys ?? (text !== undefined && text !== "" ? ["enter"] : [])
        const bytes = pressed.map((key) => [key, keyBytes(key)] as const)
        const unknown = bytes.find(([, b]) => b === undefined)
        if (unknown !== undefined) return yield* error("failed", `rex: no key named ${unknown[0]}`)
        if (text !== undefined && text !== "") {
          yield* call("block.event", {
            session_id: place.session,
            block_id: place.block,
            event: { type: "paste", payload: { text } },
          })
          // A TUI that reads a paste then a key at once may take the key as part of the paste.
          if (bytes.length > 0) yield* sleep(100)
        }
        if (bytes.length > 0) yield* method(terminal, "write", { data: bytes.map(([, b]) => b).join("") })
      })

    const read: Runtime["read"] = (terminal, lines) =>
      method<{ content: string }>(terminal, "format", { trim: true, unwrap: true }).pipe(
        Effect.map((r) => r.content.replace(/\n+$/, "").split("\n").slice(-lines).join("\n")),
      )

    const close: Runtime["close"] = (terminal) =>
      Effect.flatMap(at(terminal), (place) =>
        call("block.close", { session_id: place.session, block_id: place.block }).pipe(
          Effect.asVoid,
          // Already gone (its program ended and Rex closed it): nothing left to close.
          Effect.catchTag("RuntimeError", (e) => (e.code === "not_found" ? Effect.void : Effect.fail(e))),
        ),
      )

    const present: Runtime["present"] = (terminal, info) =>
      Effect.gen(function* () {
        const place = yield* at(terminal)
        // vibest's labels on the block; Rex shows only a label, so anything else a caller passes is left alone.
        const label = [info["title"] || info["agent"], info["harness"]].filter(Boolean).join(" · ")
        if (label === "") return
        yield* call("session.set_block_label", {
          session_id: place.session,
          block_id: place.block,
          label: label.slice(0, 128),
        })
      })

    /** A detached block in a session of its own that is removed after: its program's exit code and screen. */
    const exec: Runtime["exec"] = (machine, argv, cwd) =>
      Effect.gen(function* () {
        yield* local(machine)
        const session = (yield* call<{ session_id: string }>("session.create", { label: "vibest exec" })).session_id
        return yield* Effect.gen(function* () {
          const created = yield* call<{ block_id: string }>("session.new_block", {
            session_id: session,
            flavor: SHELL,
            label: "vibest exec",
            options: { command: [...argv], cwd, exit: { on_completion: false } },
          })
          const terminal = terminalOf(session, created.block_id)
          for (;;) {
            const info = yield* method<ProcessInfo>(terminal, "process")
            if (info.last_exit !== null) {
              const output = (yield* method<{ content: string }>(terminal, "format", { trim: true, unwrap: true }))
                .content
              return { code: info.last_exit.exit_code, output }
            }
            yield* sleep(100)
          }
        }).pipe(Effect.ensuring(call("session.destroy", { session_id: session }).pipe(Effect.ignore)))
      })

    /** `rex events --all --json`, one line per event, until the server goes away. */
    const lines = Stream.callback<string>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const file = bin()
          if (file === undefined) {
            Queue.endUnsafe(queue)
            return undefined
          }
          const child = childProcess.spawn(file, [...prefix(), "events", "--all", "--json"], {
            stdio: ["ignore", "pipe", "ignore"],
          })
          readline.createInterface({ input: child.stdout }).on("line", (line) => Queue.offerUnsafe(queue, line))
          child.on("close", () => Queue.endUnsafe(queue))
          child.on("error", () => Queue.endUnsafe(queue))
          return child
        }),
        (child) => Effect.sync(() => child?.kill()),
      ),
    )

    /** One follow of the server's events: a closed block, or a program that ended (Rex sends `child_exited`; a shell
     * back at its prompt after its program, as the main agent's shell is, shows as a process change) is `exited`. */
    const follow = Effect.sync(() => ({ first: true })).pipe(
      Effect.map((state) =>
        lines.pipe(
          Stream.mapEffect((line) =>
            Effect.gen(function* () {
              // A follow after one that was connected is a connection re-made (the server may have restarted).
              const reset: ReadonlyArray<RuntimeEvent> =
                state.first && connected ? [{ type: "reset", machine: "local" }] : []
              state.first = false
              connected = true
              return [...reset, ...(yield* toEvents(line))]
            }),
          ),
          Stream.flatMap((events) => Stream.fromIterable(events)),
        ),
      ),
      Stream.unwrap,
    )

    const toEvents = (line: string) =>
      Effect.gen(function* () {
        let parsed: {
          type?: string
          payload?: { session_id?: string; event?: { type?: string; payload?: Record<string, unknown> } }
        }
        try {
          parsed = JSON.parse(line)
        } catch {
          return []
        }
        const session = parsed.payload?.session_id
        const event = parsed.payload?.event
        if (parsed.type !== "session_event" || session === undefined || event === undefined) return []
        const payload = event.payload ?? {}
        const block = payload["block_id"]
        if (typeof block !== "string") return []
        const terminal = terminalOf(session, block)
        const exited: ReadonlyArray<RuntimeEvent> = [{ type: "exited", terminal }]
        if (event.type === "block_closed") {
          lastRunning.delete(terminal.id)
          return exited
        }
        if (event.type !== "block_event") return []
        if (payload["name"] === "child_exited") return exited
        const before = lastRunning.get(terminal.id)
        if (payload["name"] !== "process_changed" || before === undefined) return []
        const now = yield* processOf(terminal).pipe(
          Effect.map((p) => p.running),
          Effect.orElseSucceed(() => false),
        )
        return before && !now ? exited : []
      })

    // Followed again whenever it ends (the server stopped, or was not up yet).
    let connected = false
    const events: Stream.Stream<RuntimeEvent> = follow.pipe(
      Stream.concat(Stream.fromEffect(sleep(5000)).pipe(Stream.drain)),
      Stream.forever,
    )

    return { kind: KIND, status, open, send, read, process: processOf, close, events, present, exec } satisfies Runtime
  })

/** Whether `pid` has child processes (a shell running something). ponytail: local pgrep; a remote machine needs exec. */
const hasChildren = (pid: number) =>
  Effect.callback<boolean>((resume) => {
    childProcess.execFile("pgrep", ["-P", String(pid)], (e) => resume(Effect.succeed(e === null)))
  })
