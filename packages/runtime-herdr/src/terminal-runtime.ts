import type * as VibestPlugin from "@vibest/plugin"
import { Runtime as RuntimeApi } from "@vibest/plugin"
import { ID, randomId } from "@vibest/schema/id"
import { shellQuote } from "@vibest/schema/layout"
import type { RuntimeLocation } from "@vibest/schema/session"
import { Cause, Config, Duration, Effect, Option, PubSub, Schedule, type Scope, Stream } from "effect"
import type { FileSystem } from "effect"
import type { HerdrFailure, HerdrShape, PushFrame, results } from "effect-herdr-sdk"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

import type { HerdrPool } from "./pool.ts"

export type AgentState = VibestPlugin.Runtime.AgentState
export type Terminal = VibestPlugin.Runtime.Terminal
export type Runtime = VibestPlugin.Runtime.RuntimeDefinition
export type RuntimeEvent = VibestPlugin.Runtime.RuntimeEvent
export type RuntimeError = VibestPlugin.Runtime.RuntimeError

export const KIND = "herdr"

export const REMOTE_SESSION = "default"

export const terminalOf = (session: string, paneId: string, name?: string): Terminal => ({
  id: name === undefined ? `${session}/${paneId}` : `${session}/${paneId}/${name}`,
})

const onAnotherMachine = (terminal: Terminal) => terminal.id.includes("@")

export const parseTerminal = (
  terminal: Terminal,
): { readonly session: string; readonly paneId: string; readonly name: string | undefined } | undefined => {
  if (onAnotherMachine(terminal)) return undefined
  const at = terminal.id.indexOf("/")
  if (at <= 0 || at === terminal.id.length - 1) return undefined
  const rest = terminal.id.slice(at + 1)
  const named = rest.indexOf("/")
  const paneId = named === -1 ? rest : rest.slice(0, named)
  if (paneId === "" || (named !== -1 && named === rest.length - 1)) return undefined
  return { session: terminal.id.slice(0, at), paneId, name: named === -1 ? undefined : rest.slice(named + 1) }
}

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

const HERDR_AGENT_KIND_BY_BINARY: Readonly<Record<string, string>> = {
  pi: "pi",
  claude: "claude",
  "cursor-agent": "cursor",
}
const agentKindOf = (binary: string): string | undefined => {
  const name = binary.slice(binary.lastIndexOf("/") + 1)
  return HERDR_AGENT_KIND_BY_BINARY[name]
}

export const agentName = (id: string) => `s-${id.replaceAll("-", "").slice(0, 30)}`

export const processStillRunning = (
  info: {
    readonly shell_pid?: number | null
    readonly foreground_processes?: ReadonlyArray<{ readonly pid: number }> | null
  },
  launchPending: boolean,
): boolean => launchPending || (info.foreground_processes ?? []).some((process) => process.pid !== info.shell_pid)

const agentNameOf = (env: Readonly<Record<string, string>>) => {
  const id = env["VIBEST_SESSION_ID"]
  return id !== undefined && ID.test(id) ? agentName(id) : `vbt-${randomId().replaceAll("-", "").slice(0, 28)}`
}

const stateOf = (status: results.AgentStatus): AgentState => (status === "done" ? "idle" : status)

const TICK = Schedule.spaced("500 millis")

const OUTPUT_TIMEOUT = Duration.seconds(30)
const BUSY_RETRIES = 40
const READY_RETRIES = 60
const INTERACTIVE_SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "tcsh", "nu"])

const HERDR_METADATA_MAX_LENGTH = 80
const cut = (value: string | undefined): string | undefined =>
  value === undefined || value === "" ? undefined : value.slice(0, HERDR_METADATA_MAX_LENGTH)

export interface PoolDeps {
  readonly pool: HerdrPool["Service"]
  readonly spawner: InstanceType<typeof ChildProcessSpawner.ChildProcessSpawner>
  readonly fs: FileSystem.FileSystem | undefined
  readonly scope: Scope.Scope
}

export const fromPool = (deps: PoolDeps): Effect.Effect<Runtime> =>
  Effect.gen(function* () {
    const { pool, spawner, fs, scope } = deps
    const events = yield* PubSub.unbounded<RuntimeEvent>()
    const logStreamEnd = (what: string) =>
      Effect.catchCause((cause: Cause.Cause<unknown>) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.logError(`${what}: ${Cause.pretty(cause)}`).pipe(
              Effect.andThen(PubSub.publish(events, { type: "reset" })),
            ),
      )
    const subscribedPanes = new Set<string>()
    const agentNameByPane = new Map<string, string>()
    let lastSeq = 0
    const nextSeq = () => Math.max(Date.now(), ++lastSeq)

    const client = (session: string) => pool.client(session).pipe(Effect.mapError(failure))

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

    const watch = (session: string, paneId: string) =>
      Effect.gen(function* () {
        const key = `${session}/${paneId}`
        if (subscribedPanes.has(key)) return
        subscribedPanes.add(key)
        yield* client(session).pipe(
          Effect.flatMap((h) =>
            h.subscribe([{ type: "pane.agent_status_changed", pane_id: paneId }, { type: "pane.agent_detected" }]).pipe(
              Stream.runForEach((frame: PushFrame) => {
                const data = frame.data as {
                  readonly type?: string
                  readonly pane_id?: string
                  readonly agent_status?: results.AgentStatus | null
                  readonly agent?: string | null
                }
                if (frame.event === "pane.agent_status_changed" && data.agent_status)
                  return PubSub.publish(events, {
                    type: "state",
                    terminal: terminalOf(session, paneId, agentNameByPane.get(key)),
                    state: stateOf(data.agent_status),
                  })
                if (data.type === "pane_agent_detected" && data.pane_id === paneId && data.agent === null)
                  return PubSub.publish(events, {
                    type: "exited",
                    terminal: terminalOf(session, paneId, agentNameByPane.get(key)),
                  })
                return Effect.void
              }),
              Effect.ignore,
              Effect.ensuring(Effect.sync(() => subscribedPanes.delete(key))),
            ),
          ),
          Effect.ignore,
          Effect.forkIn(scope),
        )
      })

    yield* pool.events.pipe(
      Stream.runForEach(({ session, frame }) => {
        const data = frame.data as { readonly type: string; readonly pane_id?: string }
        return data.pane_id && (data.type === "pane_closed" || data.type === "pane_exited")
          ? PubSub.publish(events, {
              type: "exited",
              terminal: terminalOf(session, data.pane_id, agentNameByPane.get(`${session}/${data.pane_id}`)),
            })
          : Effect.void
      }),
      logStreamEnd("herdr pane events"),
      Effect.forkIn(scope),
    )
    yield* pool.restarts.pipe(
      Stream.runForEach((_session) => PubSub.publish(events, { type: "reset" })),
      logStreamEnd("herdr restarts"),
      Effect.forkIn(scope),
    )

    const status: Runtime["status"] = () =>
      spawner.string(ChildProcess.make("herdr", ["--version"])).pipe(
        Effect.as({ status: "online" as const }),
        Effect.catch(() => Effect.succeed({ status: "blocked" as const, reason: "herdr is not on PATH" })),
      )

    const doctor: NonNullable<Runtime["doctor"]> = (harnesses) => {
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

    const paneOf = (h: HerdrShape, paneId: string) =>
      h.call("pane.get", { pane_id: paneId }).pipe(
        Effect.map((r) => r.pane),
        Effect.catchTag("HerdrError", (e) =>
          e.code === "pane_not_found" ? Effect.succeed(undefined) : Effect.fail(e),
        ),
        failWith,
      )

    const agentNamed = (h: HerdrShape, name: string) =>
      h.call("agent.get", { target: name }).pipe(
        Effect.map((r) => r.agent),
        Effect.catchTag("HerdrError", (e) =>
          e.code === "agent_not_found" ? Effect.succeed(undefined) : Effect.fail(e),
        ),
        failWith,
      )

    const agentHoldingPane = (h: HerdrShape, paneId: string) =>
      h.call("agent.get", { target: paneId }).pipe(
        Effect.map((r) => r.agent),
        Effect.catchTag("HerdrError", (e) =>
          e.code === "agent_not_found" ? Effect.succeed(undefined) : Effect.fail(e),
        ),
        failWith,
      )

    const agentOfTerminal = (h: HerdrShape, paneId: string, name: string | undefined) =>
      Effect.gen(function* () {
        if (name !== undefined) {
          const started = yield* agentNamed(h, name)
          return started !== undefined && started.pane_id === paneId
            ? { agent: started, target: name, detected: false }
            : undefined
        }
        const holds = yield* agentHoldingPane(h, paneId)
        if (holds !== undefined && (holds.name ?? undefined) === undefined)
          return { agent: holds, target: paneId, detected: true }
        return undefined
      })

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

    const open: Runtime["open"] = (input) =>
      Effect.gen(function* () {
        const near = input.near !== undefined && input.remote !== true ? parseTerminal(input.near) : undefined
        const ambient = Option.getOrUndefined(
          yield* Config.option(Config.String("HERDR_SOCKET_PATH")).pipe(Effect.orDie),
        )
        const location: RuntimeLocation =
          near !== undefined
            ? { session: near.session }
            : input.remote === true
              ? { session: REMOTE_SESSION }
              : (decodeTarget(input.target) ??
                (ambient !== undefined ? { socketPath: ambient } : { session: "vibest" }))
        const session = yield* pool
          .resolve(near !== undefined ? { session: near.session } : location)
          .pipe(Effect.mapError(failure))
        const h = yield* client(session)
        const nearPane = near !== undefined ? yield* paneOf(h, near.paneId) : undefined
        const workspaceId =
          nearPane !== undefined
            ? nearPane.workspace_id
            : ((yield* groupWorkspace(h, input.project)) ??
              (yield* failWith(h.call("workspace.create", { cwd: input.project, focus: false, label: "project" })))
                .workspace.workspace_id)
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
        const name = agentNameOf(input.env)
        const kind = input.argv.length > 0 ? agentKindOf(input.argv[0]!) : undefined
        const agent = kind !== undefined
        if (agent) agentNameByPane.set(`${session}/${paneId}`, name)
        else agentNameByPane.delete(`${session}/${paneId}`)
        const tabId = split ? undefined : (yield* failWith(h.call("pane.get", { pane_id: paneId }))).pane.tab_id
        const undo = () =>
          (tabId !== undefined
            ? h.call("tab.close", { tab_id: tabId })
            : h.call("pane.close", { pane_id: paneId })
          ).pipe(Effect.ignore, Effect.asVoid)
        yield* Effect.catch(
          Effect.gen(function* () {
            if (kind !== undefined) {
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
              yield* typeLine(h, paneId, input.argv)
            }
          }),
          (error) => undo().pipe(Effect.andThen(Effect.fail(error))),
        )
        yield* watch(session, paneId)
        return terminalOf(session, paneId, agent === true ? name : undefined)
      })

    const at = (terminal: Terminal, method: string) => {
      const parsed = parseTerminal(terminal)
      return parsed !== undefined
        ? Effect.succeed(parsed)
        : Effect.fail(
            new RuntimeApi.RuntimeError({
              code: "not_found",
              message: onAnotherMachine(terminal)
                ? `terminal ${terminal.id} (${method}) is a pane on ${terminal.id.slice(terminal.id.indexOf("@") + 1)}; vibest peek and send reach it through vibest`
                : `terminal ${terminal.id} (${method}) names no herdr session`,
            }),
          )
    }

    const send: Runtime["send"] = (terminal, { text, keys }) =>
      Effect.gen(function* () {
        const place = yield* at(terminal, "send")
        const h = yield* client(place.session)
        const found = yield* agentOfTerminal(h, place.paneId, place.name)
        if (found !== undefined) {
          if (text !== undefined)
            yield* h.call("agent.get", { target: found.target }).pipe(
              Effect.ignore,
              Effect.andThen(h.call("agent.prompt", { target: found.target, text })),
              Effect.retry({
                while: (e) => e._tag === "HerdrError" && e.code === "agent_not_ready",
                times: READY_RETRIES,
                schedule: TICK,
              }),
              Effect.catchTag("HerdrError", (e) =>
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

    const run: NonNullable<Runtime["run"]> = (terminal, argv) =>
      Effect.gen(function* () {
        const place = yield* at(terminal, "run")
        const h = yield* client(place.session)
        if ((yield* paneOf(h, place.paneId)) === undefined)
          return yield* new RuntimeApi.RuntimeError({ code: "not_found", message: `pane ${place.paneId} is gone` })
        const kind = argv.length > 0 ? agentKindOf(argv[0]!) : undefined
        if (kind !== undefined && place.name !== undefined)
          return yield* startAgent(h, place.name, kind, place.paneId, argv.slice(1))
        const atShell = failWith(h.call("pane.process_info", { pane_id: place.paneId })).pipe(
          Effect.map((r) => {
            if (r.type !== "pane_process_info") return false
            const fg = r.process_info.foreground_processes ?? []
            return (
              fg.length > 0 && fg.every((p) => INTERACTIVE_SHELLS.has(p.name.replace(/^-/, "").replace(/^.*\//, "")))
            )
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
        const pending =
          place.name === undefined
            ? false
            : yield* agentNamed(h, place.name).pipe(
                Effect.map(
                  (agent) => agent !== undefined && agent.pane_id === place.paneId && agent.launch_pending === true,
                ),
              )
        return { running: processStillRunning(r.process_info, pending) }
      })

    const stillOurs = (h: HerdrShape, paneId: string, name: string | undefined) =>
      Effect.gen(function* () {
        const started = name === undefined ? undefined : yield* agentNamed(h, name)
        if (started !== undefined && started.pane_id !== paneId)
          return yield* new RuntimeApi.RuntimeError({
            code: "failed",
            message: `pane ${paneId} kept: its agent moved to pane ${started.pane_id}`,
          })
        if (started === undefined) {
          const holds = yield* agentHoldingPane(h, paneId)
          if (holds !== undefined && (name !== undefined || (holds.name ?? undefined) !== undefined))
            return yield* new RuntimeApi.RuntimeError({
              code: "failed",
              message: `pane ${paneId} kept: another agent (${holds.name ?? "unnamed"}) holds it`,
            })
        }
      })

    const focus: Runtime["focus"] = (terminal) =>
      Effect.gen(function* () {
        const place = yield* at(terminal, "focus")
        const h = yield* client(place.session)
        yield* failWith(h.call("pane.focus", { pane_id: place.paneId })).pipe(Effect.asVoid)
      })

    const close: Runtime["close"] = (terminal) =>
      Effect.gen(function* () {
        const place = yield* at(terminal, "close")
        const h = yield* client(place.session)
        const pane = yield* paneOf(h, place.paneId)
        if (pane === undefined) return
        yield* stillOurs(h, place.paneId, place.name)
        let paneId = place.paneId
        const mustMoveOutBeforeClose = (workspaceId: string) =>
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
        const current = yield* paneOf(h, paneId)
        if (current !== undefined && (yield* mustMoveOutBeforeClose(current.workspace_id))) {
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
        const found = yield* agentOfTerminal(h, place.paneId, place.name)
        if (found !== undefined && place.name !== undefined)
          agentNameByPane.set(`${place.session}/${place.paneId}`, place.name)
        if (found === undefined)
          return yield* new RuntimeApi.RuntimeError({
            code: "not_found",
            message: `pane ${place.paneId} holds no agent of this terminal`,
          })
        if (!found.agent.agent) return "unknown"
        return found.detected || found.agent.interactive_ready ? stateOf(found.agent.agent_status) : "unknown"
      })

    const session: Runtime["session"] = (terminal) =>
      Effect.gen(function* () {
        const place = yield* at(terminal, "session")
        const h = yield* client(place.session)
        const found = yield* agentOfTerminal(h, place.paneId, place.name)
        return found !== undefined ? (found.agent.agent_session?.value ?? null) : null
      })

    const present: Runtime["present"] = (terminal, info) =>
      Effect.gen(function* () {
        const place = yield* at(terminal, "present")
        if (cut(info.entrySession) !== undefined) yield* watch(place.session, place.paneId)
        if (["agent", "harness", "project", "live"].every((key) => cut(info[key]) === undefined)) return
        const h = yield* client(place.session)
        const pane = yield* failWith(h.call("pane.get", { pane_id: place.paneId }))
        const seq = nextSeq()
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
      id: KIND,
      status,
      open,
      send,
      read,
      process,
      close,
      focus,
      run,
      state,
      session,
      events: Stream.fromPubSub(events),
      present,
      doctor,
      attach: (target) => {
        const location = decodeTarget(target)
        return location !== undefined && "session" in location
          ? ["herdr", "session", "attach", location.session]
          : ["herdr"]
      },
    } satisfies Runtime
  })
