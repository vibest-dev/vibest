import type * as VibestPlugin from "@vibest/plugin"
import { Runtime as RuntimeApi } from "@vibest/plugin"
import { shellQuote } from "@vibest/schema/layout"
import type { RuntimeLocation } from "@vibest/schema/session"
import { Config, Duration, Effect, Option, PubSub, Schedule, type Scope, Stream } from "effect"
import type { FileSystem } from "effect"
// The Runtime API (runtime-api.ts) on herdr. Everything herdr-specific lives here and in the plugin: agent.start and
// interactive_ready, workspace grouping by worktree, pane tokens. A terminal id is `<herdr session>/<pane id>` (pane
// ids repeat across sessions, and are even reused after a close) plus, for a terminal whose agent `open` started, the
// agent name it gave it: `<session>/<pane>/<name>`, unique per open, so a pane id reused by herdr is never mistaken
// for the earlier terminal's agent; `Machine.target` is the caller's herdr location as JSON (runtime-port.md §2: a herdr
// session is the runtime on a machine), decoded only by this module.
import type { HerdrFailure, HerdrShape, PushFrame, results } from "effect-herdr-sdk"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

import type { HerdrPool } from "./pool.ts"

export type AgentState = VibestPlugin.Runtime.AgentState
export type Machine = VibestPlugin.Runtime.Machine
export type Terminal = VibestPlugin.Runtime.Terminal
export type Runtime = VibestPlugin.Runtime.Runtime
export type RuntimeEvent = VibestPlugin.Runtime.RuntimeEvent
export type RuntimeError = VibestPlugin.Runtime.RuntimeError

/** The `runtime.kind` of every row this runtime started. */
export const KIND = "herdr"

/** Terminal of `paneId` in `session` (machine is `local` in this phase), addressed by its `name` when `open` started an agent in it. */
export const terminalOf = (session: string, paneId: string, name?: string): Terminal => ({
  machine: "local",
  id: name === undefined ? `${session}/${paneId}` : `${session}/${paneId}/${name}`,
})

/** The session, pane and agent name a terminal id names (the name only for one whose agent `open` started); undefined when it is not one of ours. */
export const parseTerminal = (
  terminal: Terminal,
): { readonly session: string; readonly paneId: string; readonly name: string | undefined } | undefined => {
  const at = terminal.id.indexOf("/")
  if (at <= 0 || at === terminal.id.length - 1) return undefined
  const rest = terminal.id.slice(at + 1)
  const named = rest.indexOf("/")
  const paneId = named === -1 ? rest : rest.slice(0, named)
  if (paneId === "" || (named !== -1 && named === rest.length - 1)) return undefined
  return { session: terminal.id.slice(0, at), paneId, name: named === -1 ? undefined : rest.slice(named + 1) }
}

/** The caller's herdr location, as `Machine.target` (runtime-port.md §4): opaque to core, ours to read. */
export const encodeTarget = (location: RuntimeLocation) => JSON.stringify(location)
export const decodeTarget = (target: string | undefined): RuntimeLocation | undefined => {
  if (target === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(target)
  } catch {
    return undefined
  }
  if (typeof parsed !== "object" || parsed === null) return undefined
  const record = parsed as Record<string, unknown>
  if (typeof record.session === "string" && record.session !== "") return { session: record.session }
  if (typeof record.socketPath === "string" && record.socketPath !== "") return { socketPath: record.socketPath }
  return undefined
}

/** Any way a herdr call can fail, as the one error type of the Runtime API. */
export const failure = (
  error:
    | HerdrFailure
    | { readonly _tag: "HerdrProtocolMismatch"; readonly message: string }
    | { readonly message: string },
): RuntimeError => {
  const tag = (error as { readonly _tag?: string })._tag
  if (tag === "HerdrTransportError" || tag === "RuntimeUnreachable")
    return new RuntimeApi.RuntimeError({ code: "unreachable", message: error.message })
  if (tag === "HerdrProtocolMismatch")
    return new RuntimeApi.RuntimeError({ code: "incompatible", message: error.message })
  if (tag === "HerdrError") {
    const herdr = error as { readonly code: string; readonly method?: string }
    const code =
      herdr.code === "agent_not_found" || herdr.code === "pane_not_found"
        ? "not_found"
        : herdr.code === "agent_pane_busy"
          ? "busy"
          : "failed"
    return new RuntimeApi.RuntimeError({ code, message: `${herdr.method ?? "herdr"}: ${error.message}` })
  }
  return new RuntimeApi.RuntimeError({ code: "failed", message: error.message })
}

const failWith = <A, R>(effect: Effect.Effect<A, HerdrFailure, R>) => effect.pipe(Effect.mapError(failure))

/** The herdr agent kind a binary name runs (cursor's binary is `cursor-agent`, its kind `cursor`). */
const KINDS: Readonly<Record<string, string>> = { pi: "pi", claude: "claude", "cursor-agent": "cursor" }
const agentKindOf = (binary: string): string | undefined => {
  const name = binary.slice(binary.lastIndexOf("/") + 1)
  return KINDS[name]
}

/** The herdr agent name `open` gives a harness (`[a-z][a-z0-9_-]{0,31}`): never from the pane id, which is reused and carries uppercase (`w1:pC`). */
const agentNameOf = (env: Readonly<Record<string, string>>) => {
  // The vibest session's own id (8 lowercase hex), as the builds before the port named it: `herdr agent list` shows
  // which session runs where, and a migrated `s-<id>` row still finds its agent. Else unique per open.
  const id = env["VIBEST_SESSION_ID"]
  return id !== undefined && /^[a-z0-9_-]{1,30}$/.test(id) ? `s-${id}` : `vbt-${crypto.randomUUID().slice(0, 8)}`
}

/** `done` is herdr's own; the Runtime API's state has no such value, and an agent that is done is idle for input. */
const stateOf = (status: results.AgentStatus): AgentState => (status === "done" ? "idle" : status)

const TICK = Schedule.spaced("500 millis")

/** How long `open` waits for a fresh pane's shell to draw (generous: a loaded machine draws slowly), and how often `agent_pane_busy` is retried. */
const OUTPUT_TIMEOUT = Duration.seconds(30)
const BUSY_RETRIES = 40
/** How often `send` asks again for an agent herdr has not marked ready (about 30 s at TICK). */
const READY_RETRIES = 60
/** Process names of an interactive shell waiting at its prompt. */
const SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "tcsh", "nu"])

/** herdr drops a token or title longer than this. */
const TOKEN = 80
const cut = (value: string | undefined): string | undefined =>
  value === undefined || value === "" ? undefined : value.slice(0, TOKEN)

export interface PoolDeps {
  readonly pool: HerdrPool["Service"]
  readonly spawner: InstanceType<typeof ChildProcessSpawner.ChildProcessSpawner>
  /** Lets workspace grouping see through symlinks; without it only exact paths match. */
  readonly fs: FileSystem.FileSystem | undefined
  /** Where per-pane event subscriptions live; they close with it (the plugin's scope). */
  readonly scope: Scope.Scope
}

/**
 * The herdr Runtime: `open` is `tab.create` (the only place env can be set) plus `agent.start` for a harness argv
 * (typed into the pane's shell for anything else), `send` reaches the agent in a pane when herdr knows one, and
 * `state` is herdr's detected status. Optional members: `state`, `events`, `present`, `attach` (runtime-port.md §3);
 * herdr has no `exec`.
 */
export const fromPool = (deps: PoolDeps): Effect.Effect<Runtime> =>
  Effect.gen(function* () {
    const { pool, spawner, fs, scope } = deps
    const events = yield* PubSub.unbounded<RuntimeEvent>()
    /** Pane subscriptions installed (`<session>/<pane>`); cleared for a session when its server restarts. */
    const watched = new Set<string>()
    /** The agent name of the terminal in each pane (`<session>/<pane>`), from `open` or a `state` read, so events name the terminal the row recorded. */
    const names = new Map<string, string>()
    /** What `open` started under each agent name: its herdr kind and working directory, to know the agent again once
     * herdr dropped the name (`ours`). ponytail: in memory, so a vibestd restart forgets it; persist it if that matters. */
    const launched = new Map<string, { readonly kind: string; readonly cwd: string }>()
    /** herdr keeps a source's seq until it restarts, and drops a report that is not newer. Two publishes in one millisecond still increase. */
    let lastSeq = 0
    const nextSeq = () => Math.max(Date.now(), ++lastSeq)

    const client = (session: string) => pool.client(session).pipe(Effect.mapError(failure))

    /** The workspace `root` belongs to (a checkout's group, else a pane at it), as vibest's placement asked herdr. */
    const groupWorkspace = (h: HerdrShape, root: string) =>
      Effect.gen(function* () {
        const grouped = yield* h.call("worktree.list", { cwd: root }).pipe(
          Effect.map((r) => r.source.source_workspace_id ?? undefined),
          Effect.catchTag("HerdrError", () => Effect.succeed(undefined)),
          failWith,
        )
        if (grouped !== undefined) return grouped
        const panes = yield* failWith(h.call("pane.list", {}))
        const real = fs === undefined ? undefined : Option.getOrUndefined(yield* Effect.option(fs.realPath(root)))
        const found = yield* Effect.findFirst(panes.panes, (p) =>
          p.cwd === root
            ? Effect.succeed(true)
            : !p.cwd || real === undefined
              ? Effect.succeed(false)
              : Effect.map(Effect.option(fs!.realPath(p.cwd)), (path) => Option.getOrUndefined(path) === real),
        )
        return Option.getOrUndefined(found)?.workspace_id
      })

    /** One per-pane subscription → `state` events, and `exited` when the pane's agent is gone but the pane is not. Ends with the scope. */
    const watch = (session: string, paneId: string) =>
      Effect.gen(function* () {
        const key = `${session}/${paneId}`
        if (watched.has(key)) return
        watched.add(key)
        yield* client(session).pipe(
          Effect.flatMap((h) =>
            // `pane.agent_detected` has no pane filter (a workspace-wide subscription), so this pane's frames are picked below.
            h.subscribe([{ type: "pane.agent_status_changed", pane_id: paneId }, { type: "pane.agent_detected" }]).pipe(
              Stream.runForEach((frame: PushFrame) => {
                const data = frame.data as {
                  readonly type: string
                  readonly pane_id?: string
                  readonly agent_status?: results.AgentStatus | null
                  readonly agent?: string | null
                }
                if (data.type === "pane_agent_status_changed" && data.agent_status)
                  return PubSub.publish(events, {
                    type: "state",
                    terminal: terminalOf(session, paneId, names.get(key)),
                    state: stateOf(data.agent_status),
                  })
                // An agent that ended while the pane stays at its shell: the program of this terminal is gone.
                if (data.type === "pane_agent_detected" && data.pane_id === paneId && data.agent === null)
                  return PubSub.publish(events, {
                    type: "exited",
                    terminal: terminalOf(session, paneId, names.get(key)),
                  })
                return Effect.void
              }),
              // A stream that ends (a herdr restart) drops its key, so the next `state` installs a fresh one.
              Effect.ignore,
              Effect.ensuring(Effect.sync(() => watched.delete(key))),
            ),
          ),
          Effect.ignore,
          Effect.forkIn(scope),
        )
      })

    // The pool's own broadcasts: a closed pane is an exited terminal, and a program that ended (the pane back at its
    // shell) is an exited terminal too — the turn is over either way, and no one called `close`.
    yield* pool.events.pipe(
      Stream.runForEach(({ session, frame }) => {
        const data = frame.data as { readonly type: string; readonly pane_id?: string }
        return data.pane_id && (data.type === "pane_closed" || data.type === "pane_exited")
          ? PubSub.publish(events, {
              type: "exited",
              terminal: terminalOf(session, data.pane_id, names.get(`${session}/${data.pane_id}`)),
            })
          : Effect.void
      }),
      Effect.catchCause(() => Effect.void),
      Effect.forkIn(scope),
    )
    // A herdr server that came back: every per-pane subscription died with it. Their keys were dropped by each
    // stream's `ensuring`, so the next `state` installs a fresh one (core polls `state` every 5 s).
    yield* pool.restarts.pipe(
      Stream.runForEach((_session) => PubSub.publish(events, { type: "reset", machine: "local" })),
      Effect.catchCause(() => Effect.void),
      Effect.forkIn(scope),
    )

    const status: Runtime["status"] = () =>
      spawner.string(ChildProcess.make("herdr", ["--version"])).pipe(
        Effect.as({ status: "online" as const }),
        Effect.catch(() => Effect.succeed({ status: "blocked" as const, reason: "herdr is not on PATH" })),
      )

    // herdr knows an agent's state (ready, working, done) from a hook it installs into each harness itself.
    const doctor: NonNullable<Runtime["doctor"]> = (_machine, harnesses) => {
      // ponytail: `deps.spawner` is typed by its tag, so its output type is asserted here.
      const herdr = (args: ReadonlyArray<string>) =>
        (spawner.string(ChildProcess.make("herdr", [...args])) as Effect.Effect<string, unknown>).pipe(Effect.option)
      return Effect.all([herdr(["--version"]), herdr(["integration", "status"])]).pipe(
        Effect.map(([version, status]): RuntimeApi.RuntimeReport => {
          if (Option.isNone(version))
            return {
              name: "herdr",
              checks: [{ ok: false, text: "herdr is not on PATH", fix: "install herdr: https://herdr.dev" }],
            }
          const lines = Option.getOrElse(status, () => "").split("\n")
          const checks = harnesses.map((h): RuntimeApi.RuntimeCheck => {
            const hook = (lines.find((l) => l.startsWith(`${h}: `))?.slice(h.length + 2) ?? "not reported").replace(
              / \(\/.*$/,
              "",
            )
            return hook.startsWith("current")
              ? { ok: true, subject: h, text: `herdr can see its state (hook ${hook})` }
              : {
                  ok: false,
                  subject: h,
                  text: `herdr cannot see its state (hook ${hook}); its agents never become ready`,
                  fix: `herdr integration install ${h}`,
                }
          })
          return { name: `herdr ${version.value.trim().replace(/^herdr /, "")}`, checks }
        }),
      )
    }

    /** The pane record of `paneId`, undefined when the pane is gone. */
    const paneOf = (h: HerdrShape, paneId: string) =>
      h.call("pane.get", { pane_id: paneId }).pipe(
        Effect.map((r) => r.pane),
        Effect.catchTag("HerdrError", (e) =>
          e.code === "pane_not_found" ? Effect.succeed(undefined) : Effect.fail(e),
        ),
        failWith,
      )

    /** The agent `open` started under `name`; undefined when no agent of ours carries it. */
    const named = (h: HerdrShape, name: string) =>
      h.call("agent.get", { target: name }).pipe(
        Effect.map((r) => r.agent),
        Effect.catchTag("HerdrError", (e) =>
          e.code === "agent_not_found" ? Effect.succeed(undefined) : Effect.fail(e),
        ),
        failWith,
      )

    /** Whatever agent holds the pane (started by `open` or detected by herdr itself); undefined when none does. */
    const holder = (h: HerdrShape, paneId: string) =>
      h.call("agent.get", { target: paneId }).pipe(
        Effect.map((r) => r.agent),
        Effect.catchTag("HerdrError", (e) =>
          e.code === "agent_not_found" ? Effect.succeed(undefined) : Effect.fail(e),
        ),
        failWith,
      )

    /** The agent of this terminal, and how to address it: for a named terminal, only the agent `open` named, while it
     * still sits in this pane (a reused pane id is someone else's); for an unnamed one (the main agent, whose harness a
     * shell ran), the agent herdr detected holding the pane, never a named one (`open` named it for another terminal). undefined when none. */
    const ours = (h: HerdrShape, paneId: string, name: string | undefined) =>
      Effect.gen(function* () {
        if (name !== undefined) {
          const started = yield* named(h, name)
          if (started !== undefined)
            return started.pane_id === paneId ? { agent: started, target: name, detected: false } : undefined
          return yield* renamed(h, paneId, name)
        }
        const holds = yield* holder(h, paneId)
        if (holds !== undefined && (holds.name ?? undefined) === undefined)
          return { agent: holds, target: paneId, detected: true }
        return undefined
      })

    /**
     * herdr drops a started agent's name when its launch does not settle in agent.start's timeout, while the agent keeps
     * running in the pane. The one rule that knows it again: the pane still holds an unnamed agent of the kind `open`
     * started under `name`, in the same working directory. The name is put back (herdr refuses while the launch is still
     * pending; the pane addresses it then). undefined when the rule does not hold.
     */
    const renamed = (h: HerdrShape, paneId: string, name: string) =>
      Effect.gen(function* () {
        const want = launched.get(name)
        if (want === undefined) return undefined
        const holds = yield* holder(h, paneId)
        if (holds === undefined || (holds.name ?? undefined) !== undefined || holds.agent !== want.kind)
          return undefined
        const real = (dir: string) =>
          fs === undefined ? Effect.succeed(dir) : fs.realPath(dir).pipe(Effect.orElseSucceed(() => dir))
        const expected = yield* real(want.cwd)
        const dirs = [holds.cwd, holds.foreground_cwd].filter((d): d is string => typeof d === "string" && d !== "")
        if (Option.isNone(yield* Effect.findFirst(dirs, (d) => Effect.map(real(d), (r) => r === expected))))
          return undefined
        yield* h.call("agent.rename", { target: paneId, name }).pipe(Effect.ignore)
        return { agent: holds, target: paneId, detected: false }
      })

    /** herdr's agent.start: it types the harness into the pane's shell once that shell is idle, and names it `name`. */
    const startAgent = (h: HerdrShape, name: string, kind: string, paneId: string, args: ReadonlyArray<string>) =>
      h
        .call("agent.start", {
          name,
          kind,
          pane_id: paneId,
          args: [...args],
          timeout_ms: Duration.toMillis(Duration.seconds(120)),
        })
        .pipe(
          // After its harness exits, herdr keeps the name on that same pane until it sees the agent gone (`run`).
          Effect.retry({
            while: (error) =>
              error._tag === "HerdrError" &&
              error.code === "agent_name_taken" &&
              error.message.includes(`pane_id=${paneId} `),
            times: BUSY_RETRIES,
            schedule: TICK,
          }),
          failWith,
        )
        .pipe(
          Effect.retry({ while: (error) => error.code === "busy", times: BUSY_RETRIES, schedule: TICK }),
          // herdr sees an agent through its own integration for that harness; without it a start never settles.
          Effect.mapError((error) =>
            error.code === "failed"
              ? new RuntimeApi.RuntimeError({
                  code: error.code,
                  message: `${error.message} (if herdr never saw ${kind} start, check \`herdr integration status\`)`,
                })
              : error,
          ),
        )

    const typeLine = (h: HerdrShape, paneId: string, argv: ReadonlyArray<string>) =>
      failWith(h.call("pane.send_text", { pane_id: paneId, text: argv.map(shellQuote).join(" ") })).pipe(
        Effect.andThen(failWith(h.call("pane.send_keys", { pane_id: paneId, keys: ["enter"] }))),
      )

    const open: Runtime["open"] = (machine, input) =>
      Effect.gen(function* () {
        // The session: beside `near`, else the caller's location, else the ambient socket, else the default session.
        const near = input.near !== undefined ? parseTerminal(input.near) : undefined
        const ambient = Option.getOrUndefined(
          yield* Config.option(Config.String("HERDR_SOCKET_PATH")).pipe(Effect.orDie),
        )
        const location: RuntimeLocation =
          near !== undefined
            ? { session: near.session }
            : (decodeTarget(machine.target) ??
              (ambient !== undefined ? { socketPath: ambient } : { session: "vibest" }))
        const session = yield* pool
          .resolve(near !== undefined ? { session: near.session } : location)
          .pipe(Effect.mapError(failure))
        const h = yield* client(session)
        // `near` places the terminal only while that pane still exists: a stale address (the pane closed while
        // vibestd was down, or herdr restarted) must not fail every later start, so it falls back to the group.
        const nearPane = near !== undefined ? yield* paneOf(h, near.paneId) : undefined
        const workspaceId =
          nearPane !== undefined
            ? nearPane.workspace_id
            : ((yield* groupWorkspace(h, input.project)) ??
              (yield* failWith(h.call("workspace.create", { cwd: input.project, focus: false, label: "project" })))
                .workspace.workspace_id)
        // A split beside `near` when asked for one (`vibest run --peer`); otherwise a tab of its own in the workspace.
        const split = input.split === true && nearPane !== undefined
        const paneId = split
          ? (yield* failWith(
              h.call("pane.split", {
                target_pane_id: nearPane!.pane_id,
                direction: "right",
                cwd: input.cwd,
                env: { ...input.env },
                focus: input.focus === true,
              }),
            )).pane.pane_id
          : (yield* failWith(
              h.call("tab.create", {
                workspace_id: workspaceId,
                cwd: input.cwd,
                env: { ...input.env },
                focus: input.focus === true,
                label: input.label,
              }),
            )).root_pane.pane_id
        // The name the terminal's agent (if `open` starts one) is addressed by, unique per open.
        const name = agentNameOf(input.env)
        const kind = input.argv.length > 0 ? agentKindOf(input.argv[0]!) : undefined
        const agent = kind !== undefined
        if (agent) {
          names.set(`${session}/${paneId}`, name)
          launched.set(name, { kind, cwd: input.cwd })
        } else names.delete(`${session}/${paneId}`)
        const tabId = split ? undefined : (yield* failWith(h.call("pane.get", { pane_id: paneId }))).pane.tab_id
        // Everything after the terminal exists is undone when it fails: a start that dies inside it (a harness on
        // its own usage limit, a bad flag) must not leave an empty shell behind (core only closes what `open` returned).
        const undo = () =>
          (tabId !== undefined
            ? h.call("tab.close", { tab_id: tabId })
            : h.call("pane.close", { pane_id: paneId })
          ).pipe(Effect.ignore, Effect.asVoid)
        yield* Effect.catch(
          Effect.gen(function* () {
            if (kind !== undefined) {
              // A fresh pane's shell may still be starting.
              yield* startAgent(h, name, kind, paneId, input.argv.slice(1))
            } else {
              yield* failWith(
                h.call("pane.wait_for_output", {
                  pane_id: paneId,
                  source: "visible",
                  match: { type: "regex", value: "\\S" },
                  timeout_ms: Duration.toMillis(OUTPUT_TIMEOUT),
                }),
              )
              // Not exec'd: the terminal stays at its shell after the program ends, so `run` can start one there again.
              yield* typeLine(h, paneId, input.argv)
            }
          }),
          (error) => undo().pipe(Effect.andThen(Effect.fail(error))),
        )
        yield* watch(session, paneId)
        return terminalOf(session, paneId, agent === true ? name : undefined)
      })

    /** The session and pane a terminal id names, or a not_found error. */
    const at = (terminal: Terminal, method: string) => {
      const parsed = parseTerminal(terminal)
      return parsed !== undefined
        ? Effect.succeed(parsed)
        : Effect.fail(
            new RuntimeApi.RuntimeError({
              code: "not_found",
              message: `terminal ${terminal.id} (${method}) names no herdr session`,
            }),
          )
    }

    const send: Runtime["send"] = (terminal, { text, keys }) =>
      Effect.gen(function* () {
        const place = yield* at(terminal, "send")
        const h = yield* client(place.session)
        // The agent of this terminal — addressed by its `open` name or, for one herdr detected (the main agent), by
        // its pane. `agent.prompt` submits (Enter), as a prompt does; the pane fallback only types.
        const found = yield* ours(h, place.paneId, place.name)
        if (found !== undefined) {
          // herdr refuses a prompt to an agent it has not marked ready yet (`agent_not_ready`): one `open` started is
          // marked once herdr sees it idle. Prompted before that, it works without the mark, and herdr drops its name
          // when agent.start's timeout passes unmarked: the terminal reads as exited while its harness works. So the
          // prompt waits for the mark; an agent herdr never marks (its herdr integration missing) gets the text pasted
          // and Enter, as a user would.
          if (text !== undefined)
            yield* h.call("agent.prompt", { target: found.target, text }).pipe(
              Effect.retry({
                while: (e) => e._tag === "HerdrError" && e.code === "agent_not_ready",
                times: READY_RETRIES,
                schedule: TICK,
              }),
              Effect.catchTag("HerdrError", (e) =>
                // `send_input`, not `send_text`: one bracketed paste, as agent.prompt sends it. Raw bytes reach a TUI
                // as keystrokes in chunks, and a long multi-line text arrives split, its first chunks lost.
                e.code === "agent_not_ready"
                  ? h.call("pane.send_input", { pane_id: place.paneId, text, keys: ["enter"] })
                  : Effect.fail(e),
              ),
              failWith,
            )
          if (keys !== undefined && keys.length > 0)
            yield* failWith(h.call("agent.send_keys", { target: found.target, keys: [...keys] }))
        } else {
          if (text !== undefined) yield* failWith(h.call("pane.send_text", { pane_id: place.paneId, text }))
          if (keys !== undefined && keys.length > 0)
            yield* failWith(h.call("pane.send_keys", { pane_id: place.paneId, keys: [...keys] }))
        }
      })

    /**
     * A harness in a named terminal goes through agent.start again, which waits for an idle shell and names it as `open`
     * did; any other command is typed once only the pane's shell is in its foreground.
     */
    const run: NonNullable<Runtime["run"]> = (terminal, argv) =>
      Effect.gen(function* () {
        const place = yield* at(terminal, "run")
        const h = yield* client(place.session)
        if ((yield* paneOf(h, place.paneId)) === undefined)
          return yield* new RuntimeApi.RuntimeError({ code: "not_found", message: `pane ${place.paneId} is gone` })
        const kind = argv.length > 0 ? agentKindOf(argv[0]!) : undefined
        if (kind !== undefined && place.name !== undefined)
          return yield* startAgent(h, place.name, kind, place.paneId, argv.slice(1))
        // Only a shell in the foreground: the pane's own, or one a wrapper left there (`sh -c '"$@"; exec $SHELL'`).
        const atShell = failWith(h.call("pane.process_info", { pane_id: place.paneId })).pipe(
          Effect.map((r) => {
            if (r.type !== "pane_process_info") return false
            const fg = r.process_info.foreground_processes ?? []
            return fg.length > 0 && fg.every((p) => SHELLS.has(p.name.replace(/^-/, "").replace(/^.*\//, "")))
          }),
        )
        const idle = yield* atShell.pipe(
          Effect.repeat({ until: (ok) => ok, schedule: TICK }),
          Effect.timeoutOrElse({ duration: OUTPUT_TIMEOUT, orElse: () => Effect.succeed(false) }),
        )
        if (!idle)
          return yield* new RuntimeApi.RuntimeError({
            code: "busy",
            message: `pane ${place.paneId} did not come back to its shell within ${Duration.format(OUTPUT_TIMEOUT)}`,
          })
        yield* typeLine(h, place.paneId, argv)
      })

    const read: Runtime["read"] = (terminal, lines) =>
      Effect.gen(function* () {
        const place = yield* at(terminal, "read")
        const h = yield* client(place.session)
        return (yield* failWith(h.call("pane.read", { pane_id: place.paneId, source: "recent_unwrapped", lines }))).read
          .text
      })

    const process: Runtime["process"] = (terminal) =>
      Effect.gen(function* () {
        const place = yield* at(terminal, "process")
        const h = yield* client(place.session)
        const r = yield* failWith(h.call("pane.process_info", { pane_id: place.paneId }))
        if (r.type !== "pane_process_info") return { running: false }
        const info = r.process_info
        // The pane's program is what runs besides its shell; the shell alone is not a running program.
        const others = (info.foreground_processes ?? []).filter((p) => p.pid !== info.shell_pid)
        return { running: others.length > 0 }
      })

    /** The pane is still this terminal's to close. A named terminal: its agent still sits in it, or the pane holds no
     * agent at all (it exited to the shell). An unnamed one (the main agent): no named agent holds the pane. Pane
     * ids are reused, so a pane another agent holds is never closed by this terminal's old id. */
    const stillOurs = (h: HerdrShape, paneId: string, name: string | undefined) =>
      Effect.gen(function* () {
        const started = name === undefined ? undefined : yield* named(h, name)
        if (started !== undefined && started.pane_id !== paneId)
          return yield* new RuntimeApi.RuntimeError({
            code: "failed",
            message: `pane ${paneId} kept: its agent moved to pane ${started.pane_id}`,
          })
        if (started === undefined) {
          const holds = yield* holder(h, paneId)
          if (holds !== undefined && (name !== undefined || (holds.name ?? undefined) !== undefined))
            return yield* new RuntimeApi.RuntimeError({
              code: "failed",
              message: `pane ${paneId} kept: another agent (${holds.name ?? "unnamed"}) holds it`,
            })
        }
      })

    /**
     * Close the pane. herdr closes a workspace with its last pane, and a main checkout's workspace takes its linked
     * worktrees' workspaces with it, so the last pane of a workspace that is not listed, or whose worktree is not a
     * linked one (a main checkout), is moved alone into a workspace of its own first. A workspace without a worktree
     * closes at most itself. The check runs right before the close: a sibling closing in the gap must not turn this
     * close into a group close.
     */
    const close: Runtime["close"] = (terminal) =>
      Effect.gen(function* () {
        const place = yield* at(terminal, "close")
        const h = yield* client(place.session)
        const pane = yield* paneOf(h, place.paneId)
        if (pane === undefined) return
        yield* stillOurs(h, place.paneId, place.name)
        let paneId = place.paneId
        /** Whether the last pane of `workspaceId` must be moved out before it is closed. */
        const isolate = (workspaceId: string) =>
          Effect.gen(function* () {
            const panes = yield* failWith(h.call("pane.list", { workspace_id: workspaceId }))
            if (panes.panes.length > 1) return false
            const workspaces = yield* failWith(h.call("workspace.list", {}))
            const workspace = workspaces.workspaces.find((w) => w.workspace_id === workspaceId)
            return (
              workspace === undefined ||
              (workspace.worktree !== null &&
                workspace.worktree !== undefined &&
                !workspace.worktree.is_linked_worktree)
            )
          })
        // One path: the pane is read again right before the close, so a sibling that closed in the gap cannot turn
        // this close into a group close.
        const current = yield* paneOf(h, paneId)
        if (current !== undefined && (yield* isolate(current.workspace_id))) {
          const moved = yield* failWith(
            h.call("pane.move", {
              pane_id: paneId,
              destination: { type: "new_workspace", label: "closing" },
              focus: false,
            }),
          )
          if (moved.type === "pane_move") {
            paneId = moved.move_result.pane.pane_id
            yield* stillOurs(h, paneId, place.name)
          }
        }
        yield* failWith(h.call("pane.close", { pane_id: paneId })).pipe(Effect.asVoid)
      })

    const state: Runtime["state"] = (terminal) =>
      Effect.gen(function* () {
        const place = yield* at(terminal, "state")
        const h = yield* client(place.session)
        yield* watch(place.session, place.paneId)
        const found = yield* ours(h, place.paneId, place.name)
        // A row from before this vibestd (a restart, a migrated `s-<id>` row) teaches the name its events must carry,
        // once its agent is found in the pane (a stale row on a reused pane id must not rename the live one).
        if (found !== undefined && place.name !== undefined) names.set(`${place.session}/${place.paneId}`, place.name)
        // No agent of ours in the pane: not_found, so core reads "absent" — a reused pane id is not this terminal.
        if (found === undefined)
          return yield* new RuntimeApi.RuntimeError({
            code: "not_found",
            message: `pane ${place.paneId} holds no agent of this terminal`,
          })
        // A detected agent (the main agent) reports its status as herdr reads it; one `open` started only once ready.
        if (!found.agent.agent) return "unknown"
        return found.detected || found.agent.interactive_ready ? stateOf(found.agent.agent_status) : "unknown"
      })

    const session: Runtime["session"] = (terminal) =>
      Effect.gen(function* () {
        const place = yield* at(terminal, "session")
        const h = yield* client(place.session)
        const found = yield* ours(h, place.paneId, place.name)
        return found !== undefined ? (found.agent.agent_session?.value ?? null) : null
      })

    const present: Runtime["present"] = (terminal, info) =>
      Effect.gen(function* () {
        const place = yield* at(terminal, "present")
        const h = yield* client(place.session)
        const pane = yield* failWith(h.call("pane.get", { pane_id: place.paneId }))
        const seq = nextSeq()
        // vibest's labels: pane tokens for the session, a workspace token for the Project. Anything else a caller
        // passes is left alone — herdr shows only what it knows a key for.
        const value = (key: string) => cut(info[key])
        const agent = value("agent")
        const harness = value("harness")
        if (agent !== undefined || harness !== undefined) {
          const tokens: Record<string, string | null> = {}
          if (value("definition") !== undefined) tokens.definition = value("definition")!
          if (value("session") !== undefined) tokens.session = value("session")!
          const title = value("title")
          yield* failWith(
            h.call("pane.report_metadata", {
              pane_id: place.paneId,
              source: "vibest",
              display_agent: cut([agent, harness].filter(Boolean).join(" · "))!,
              state_labels: { blocked: "waiting for you" },
              ...(title === undefined ? {} : { title }),
              tokens,
              seq,
            }),
          ).pipe(Effect.asVoid)
        }
        if (value("project") !== undefined || value("live") !== undefined) {
          const tokens: Record<string, string | null> = {}
          if (value("project") !== undefined) tokens.project = value("project")!
          if (value("live") !== undefined) tokens.agents = value("live")!
          yield* failWith(
            h.call("workspace.report_metadata", {
              workspace_id: pane.pane.workspace_id,
              source: "vibest",
              tokens,
              seq,
            }),
          ).pipe(Effect.asVoid)
        }
      })

    return {
      kind: KIND,
      status,
      open,
      send,
      read,
      process,
      close,
      run,
      state,
      session,
      events: Stream.fromPubSub(events),
      present,
      doctor,
      attach: (machine) => {
        const target = decodeTarget(machine.target)
        return target !== undefined && "session" in target ? ["herdr", "session", "attach", target.session] : ["herdr"]
      },
    } satisfies Runtime
  })
