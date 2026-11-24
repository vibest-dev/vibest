import { NodeFileSystem, NodePath } from "@effect/platform-node-shared"
import type * as VibestPlugin from "@vibest/plugin/effect"
import { Runtime as RuntimeApi } from "@vibest/plugin/effect"
import { typedLine } from "@vibest/plugin/effect/launch"
import type { RuntimeLocation, RuntimeUnreachable } from "@vibest/schema/session"
import {
  Cause,
  Config,
  Duration,
  Effect,
  Option,
  Predicate,
  PubSub,
  Schedule,
  Schema,
  type Scope,
  Stream,
} from "effect"
import type { FileSystem } from "effect"
import type { Frame, HerdrFailure, HerdrClient, results } from "effect-herdr-sdk"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

import type { HerdrPool } from "./pool.ts"

export const HerdrTerminal = Schema.Struct({
  session: Schema.NonEmptyString,
  pane: Schema.NonEmptyString,
  name: Schema.optionalKey(Schema.NonEmptyString),
  machine: Schema.optionalKey(Schema.NonEmptyString),
})

export type HerdrTerminal = typeof HerdrTerminal.Type

export type AgentState = VibestPlugin.Runtime.AgentState

export type Terminal = HerdrTerminal

export type Runtime = VibestPlugin.Runtime.RuntimeDefinition

export type RuntimeEvent = VibestPlugin.Runtime.RuntimeEvent<HerdrTerminal>

export type RuntimeError = VibestPlugin.Runtime.RuntimeError

export const KIND = "herdr"

export const REMOTE_SESSION = "default"

export const terminalOf = (session: string, pane: string, name?: string): HerdrTerminal => ({
  session,
  pane,
  ...(name !== undefined && { name }),
})

export const formatHerdrTerminal = (terminal: HerdrTerminal): string =>
  `${terminal.session}/${terminal.pane}${terminal.name === undefined ? "" : `/${terminal.name}`}${terminal.machine === undefined ? "" : `@${terminal.machine}`}`

export const encodeTarget = (location: RuntimeLocation) => JSON.stringify(location)

const decodeTargetJson = Schema.decodeOption(
  Schema.fromJsonString(
    Schema.Struct({ session: Schema.optionalKey(Schema.Json), socketPath: Schema.optionalKey(Schema.Json) }),
  ),
)

export const decodeTarget = (target: string | undefined): RuntimeLocation | undefined => {
  if (target === undefined) return undefined
  const decoded = decodeTargetJson(target)

  if (Option.isNone(decoded)) return undefined
  const record = decoded.value

  if (Predicate.isString(record.session) && record.session !== "") return { session: record.session }

  if (Predicate.isString(record.socketPath) && record.socketPath !== "") return { socketPath: record.socketPath }

  return undefined
}

export const failure = (
  error:
    | HerdrFailure
    | { readonly _tag: "HerdrProtocolMismatch"; readonly message: string }
    | RuntimeUnreachable
    | { readonly _tag?: undefined; readonly message: string },
): RuntimeError => {
  if (Predicate.isTagged(error, "HerdrTransportError") || Predicate.isTagged(error, "RuntimeUnreachable"))
    return new RuntimeApi.RuntimeError({ code: "unreachable", message: error.message })

  if (Predicate.isTagged(error, "HerdrProtocolMismatch"))
    return new RuntimeApi.RuntimeError({ code: "incompatible", message: error.message })

  if (Predicate.isTagged(error, "HerdrError")) {
    const herdr = error

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

export const agentName = (id: string) => `s-${id.replaceAll("-", "").slice(0, 30)}`

export const processStillRunning = (
  info: {
    readonly shell_pid?: number | null
    readonly foreground_processes?: ReadonlyArray<{ readonly pid: number }> | null
  },
  launchPending: boolean,
): boolean => launchPending || (info.foreground_processes ?? []).some((process) => process.pid !== info.shell_pid)

const stateOf = (status: results.AgentStatus): AgentState => (status === "done" ? "idle" : status)

const AgentStatus: Schema.Codec<results.AgentStatus> = Schema.Literals([
  "idle",
  "working",
  "blocked",
  "done",
  "unknown",
])

const decodeAgentFrame = Schema.decodeUnknownOption(
  Schema.Struct({
    type: Schema.optional(Schema.String),
    pane_id: Schema.optional(Schema.String),
    agent_status: Schema.optional(Schema.NullOr(AgentStatus)),
    agent: Schema.optional(Schema.NullOr(Schema.String)),
  }),
)

const decodePaneFrame = Schema.decodeUnknownOption(
  Schema.Struct({ type: Schema.String, pane_id: Schema.optional(Schema.String) }),
)

const TICK = Schedule.spaced("500 millis")

const OUTPUT_TIMEOUT = Duration.seconds(30)
const READY_RETRIES = 60
const INTERACTIVE_SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "tcsh", "nu"])

const HERDR_METADATA_MAX_LENGTH = 80

const cut = (value: string | undefined): string | undefined =>
  value === undefined || value === "" ? undefined : value.slice(0, HERDR_METADATA_MAX_LENGTH)

export interface PoolDeps {
  readonly pool: HerdrPool["Service"]
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]
  readonly fs: FileSystem.FileSystem | undefined
  readonly scope: Scope.Scope
  readonly caller?: VibestPlugin.Runtime.RuntimeCaller<HerdrTerminal>
  readonly link?: VibestPlugin.Runtime.RuntimeDefinition<HerdrTerminal>["link"]
  readonly locate?: VibestPlugin.Runtime.RuntimeDefinition<HerdrTerminal>["locate"]
}

export const fromPool = (deps: PoolDeps): Effect.Effect<Runtime> =>
  Effect.gen(function* () {
    const { pool, spawner, fs, scope } = deps
    const events = yield* PubSub.unbounded<RuntimeEvent>()

    const logStreamEnd = (what: string) =>
      Effect.catchCause((cause: Cause.Cause<unknown>) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.logError(what, cause).pipe(Effect.andThen(PubSub.publish(events, { type: "reset" }))),
      )

    const subscribedPanes = new Set<string>()
    const agentNameByPane = new Map<string, string>()
    let lastSeq = 0
    const nextSeq = () => Math.max(Date.now(), ++lastSeq)

    const client = (session: string) => pool.client(session).pipe(Effect.mapError(failure))

    const groupWorkspace = (h: HerdrClient, root: string) =>
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
              Stream.runForEach((frame: Frame) => {
                const decoded = decodeAgentFrame(frame.data)

                if (Option.isNone(decoded)) return Effect.void
                const data = decoded.value

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
        const decoded = decodePaneFrame(frame.data)

        if (Option.isNone(decoded)) return Effect.void
        const data = decoded.value

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
        spawner.string(ChildProcess.make("herdr", [...args])).pipe(Effect.option)

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
              ? { ok: true, subject: h, text: `herdr can see its state, hook ${hook}` }
              : {
                  ok: false,
                  subject: h,
                  text: `herdr cannot see its state, hook ${hook}; its agents never become ready`,
                  fix: `herdr integration install ${h}`,
                }
          })

          return { name: `herdr ${version.value.trim().replace(/^herdr /, "")}`, checks }
        }),
      )
    }

    const paneOf = (h: HerdrClient, paneId: string) =>
      h.call("pane.get", { pane_id: paneId }).pipe(
        Effect.map((r) => r.pane),
        Effect.catchTag("HerdrError", (e) =>
          e.code === "pane_not_found" ? Effect.succeed(undefined) : Effect.fail(e),
        ),
        failWith,
      )

    const agentNamed = (h: HerdrClient, name: string) =>
      h.call("agent.get", { target: name }).pipe(
        Effect.map((r) => r.agent),
        Effect.catchTag("HerdrError", (e) =>
          e.code === "agent_not_found" ? Effect.succeed(undefined) : Effect.fail(e),
        ),
        failWith,
      )

    const agentHoldingPane = (h: HerdrClient, paneId: string) =>
      h.call("agent.get", { target: paneId }).pipe(
        Effect.map((r) => r.agent),
        Effect.catchTag("HerdrError", (e) =>
          e.code === "agent_not_found" ? Effect.succeed(undefined) : Effect.fail(e),
        ),
        failWith,
      )

    const agentOfTerminal = (h: HerdrClient, paneId: string, name: string | undefined) =>
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

    const typeLine = (h: HerdrClient, paneId: string, text: string) =>
      failWith(h.call("pane.send_text", { pane_id: paneId, text })).pipe(
        Effect.andThen(failWith(h.call("pane.send_keys", { pane_id: paneId, keys: ["enter"] }))),
      )

    const typed = (launch: VibestPlugin.Launch) =>
      typedLine(launch).pipe(
        Effect.mapError((e) => new RuntimeApi.RuntimeError({ code: "failed", message: e.message })),
        Effect.provide(NodeFileSystem.layer),
        Effect.provide(NodePath.layer),
      )

    const open: VibestPlugin.Runtime.RuntimeDefinition<HerdrTerminal>["open"] = (input) =>
      Effect.gen(function* () {
        const near =
          input.near !== undefined && input.remote !== true && input.near.machine === undefined ? input.near : undefined

        const ambient = Option.getOrUndefined(
          yield* Config.option(Config.String("HERDR_SOCKET_PATH")).pipe(Effect.orDie),
        )

        const fallbackLocation: RuntimeLocation =
          input.remote === true
            ? { session: REMOTE_SESSION }
            : (decodeTarget(input.target) ?? (ambient !== undefined ? { socketPath: ambient } : { session: "vibest" }))

        const connectLocation = (location: RuntimeLocation) =>
          pool.resolve(location).pipe(
            Effect.mapError(failure),
            Effect.flatMap((resolved) => client(resolved).pipe(Effect.map((h) => ({ session: resolved, h })))),
          )

        const sameAsFallback =
          near !== undefined && "session" in fallbackLocation && fallbackLocation.session === near.session

        const connected =
          near !== undefined
            ? yield* connectLocation({ session: near.session }).pipe(
                Effect.map((c) => ({ ...c, useNear: true })),
                Effect.catchIf(
                  (e) => !sameAsFallback && e.code === "unreachable",
                  () => connectLocation(fallbackLocation).pipe(Effect.map((c) => ({ ...c, useNear: false }))),
                ),
              )
            : yield* connectLocation(fallbackLocation).pipe(Effect.map((c) => ({ ...c, useNear: false })))

        const { session, h, useNear } = connected
        const nearPane = near !== undefined && useNear ? yield* paneOf(h, near.pane) : undefined

        const workspaceId =
          nearPane !== undefined
            ? nearPane.workspace_id
            : ((yield* groupWorkspace(h, input.project)) ??
              (yield* failWith(h.call("workspace.create", { cwd: input.project, focus: false, label: "project" })))
                .workspace.workspace_id)

        const split = input.split === true && nearPane !== undefined
        const { VIBEST_EXECUTION: _, ...shellEnv } = input.launch.env

        const paneId = split
          ? (yield* failWith(
              h.call("pane.split", {
                target_pane_id: nearPane!.pane_id,
                direction: "right",
                cwd: input.cwd,
                env: shellEnv,
                focus: input.focus === true,
              }),
            )).pane.pane_id
          : (yield* failWith(
              h.call("tab.create", {
                workspace_id: workspaceId,
                cwd: input.cwd,
                env: shellEnv,
                focus: input.focus === true,
                label: input.label,
              }),
            )).root_pane.pane_id

        agentNameByPane.delete(`${session}/${paneId}`)
        const tabId = split ? undefined : (yield* failWith(h.call("pane.get", { pane_id: paneId }))).pane.tab_id

        const undo = () =>
          (tabId !== undefined
            ? h.call("tab.close", { tab_id: tabId })
            : h.call("pane.close", { pane_id: paneId })
          ).pipe(Effect.ignore, Effect.asVoid)

        yield* Effect.catch(
          Effect.gen(function* () {
            yield* failWith(
              h.call("pane.wait_for_output", {
                pane_id: paneId,
                source: "visible",
                match: { type: "regex", value: "\\S" },
                timeout_ms: Duration.toMillis(OUTPUT_TIMEOUT),
              }),
            )

            const line =
              input.launch.argv.length === 0 && input.launch.prompt === undefined ? "" : yield* typed(input.launch)

            if (line.length > 0) yield* typeLine(h, paneId, line)
          }),
          (error) => undo().pipe(Effect.andThen(Effect.fail(error))),
        )
        yield* watch(session, paneId)

        return terminalOf(session, paneId)
      })

    const at = (terminal: HerdrTerminal, method: string) =>
      terminal.machine === undefined
        ? Effect.succeed({ session: terminal.session, paneId: terminal.pane, name: terminal.name })
        : Effect.fail(
            new RuntimeApi.RuntimeError({
              code: "not_found",
              message: `terminal ${formatHerdrTerminal(terminal)} (${method}) is a pane on ${terminal.machine}; vibest peek and send reach it through vibest`,
            }),
          )

    const send: VibestPlugin.Runtime.RuntimeDefinition<HerdrTerminal>["send"] = (terminal, { text, keys }) =>
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
                while: (e) => Predicate.isTagged(e, "HerdrError") && e.code === "agent_not_ready",
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

          const pressed = [...(text === undefined ? [] : ["enter"]), ...(keys ?? [])]

          if (pressed.length > 0) yield* failWith(h.call("pane.send_keys", { pane_id: place.paneId, keys: pressed }))
        }
      })

    const run: NonNullable<VibestPlugin.Runtime.RuntimeDefinition<HerdrTerminal>["run"]> = (terminal, launch) =>
      Effect.gen(function* () {
        const place = yield* at(terminal, "run")
        const h = yield* client(place.session)

        if ((yield* paneOf(h, place.paneId)) === undefined)
          return yield* new RuntimeApi.RuntimeError({ code: "not_found", message: `pane ${place.paneId} is gone` })

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
        yield* typeLine(h, place.paneId, yield* typed(launch))
      })

    const read: VibestPlugin.Runtime.RuntimeDefinition<HerdrTerminal>["read"] = (terminal, lines) =>
      Effect.gen(function* () {
        const place = yield* at(terminal, "read")
        const h = yield* client(place.session)

        return (yield* failWith(h.call("pane.read", { pane_id: place.paneId, source: "recent_unwrapped", lines }))).read
          .text
      })

    const process: VibestPlugin.Runtime.RuntimeDefinition<HerdrTerminal>["process"] = (terminal) =>
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

    const stillOurs = (h: HerdrClient, paneId: string, name: string | undefined) =>
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

    const focus: NonNullable<VibestPlugin.Runtime.RuntimeDefinition<HerdrTerminal>["focus"]> = (terminal) =>
      Effect.gen(function* () {
        const place = yield* at(terminal, "focus")
        const h = yield* client(place.session)
        yield* failWith(h.call("pane.focus", { pane_id: place.paneId })).pipe(Effect.asVoid)
      })

    const close: VibestPlugin.Runtime.RuntimeDefinition<HerdrTerminal>["close"] = (terminal) =>
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

    const state: NonNullable<VibestPlugin.Runtime.RuntimeDefinition<HerdrTerminal>["state"]> = (terminal) =>
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

    const session: NonNullable<VibestPlugin.Runtime.RuntimeDefinition<HerdrTerminal>["session"]> = (terminal) =>
      Effect.gen(function* () {
        const place = yield* at(terminal, "session")
        const h = yield* client(place.session)
        const found = yield* agentOfTerminal(h, place.paneId, place.name)

        return found !== undefined ? (found.agent.agent_session?.value ?? null) : null
      })

    const present: NonNullable<VibestPlugin.Runtime.RuntimeDefinition<HerdrTerminal>["present"]> = (terminal, info) =>
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
              ...(title !== undefined && { title }),
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

    return RuntimeApi.define({
      id: KIND,
      ...(deps.caller !== undefined && { caller: deps.caller }),
      ...(deps.link !== undefined && { link: deps.link }),
      ...(deps.locate !== undefined && { locate: deps.locate }),
      terminal: HerdrTerminal,
      format: formatHerdrTerminal,
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
      events: RuntimeApi.eventsFrom(events),
      present,
      doctor,
      attach: (target, terminal) => {
        const location = decodeTarget(target)

        const session =
          location !== undefined && "session" in location
            ? location.session
            : terminal === undefined || terminal.machine !== undefined
              ? undefined
              : terminal.session

        return session === undefined ? ["herdr"] : ["herdr", "session", "attach", session]
      },
    })
  })
