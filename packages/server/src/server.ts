import { importCheck, spawnDaemon } from "@vibest/client/client"
import { awaitEvent, Bus, type EngineEvent } from "@vibest/core/bus"
import { callerKeys, detectCaller, unresolved } from "@vibest/core/caller-runtime"
import { type CoordinatorRow, Db, encodeAddress, type RuntimeAddress, type SessionBrief } from "@vibest/core/db"
import { Drain } from "@vibest/core/drain"
import { harnessOptions, Harnesses, HarnessUnavailable, isHarnessId } from "@vibest/core/harness"
import { coordinatorIdle, Inbox } from "@vibest/core/inbox"
import { keyedLock } from "@vibest/core/keyed-lock"
import * as Launch from "@vibest/core/launch"
import { Layout, shellQuote } from "@vibest/core/paths"
import { describeSpawn, Plugins } from "@vibest/core/plugins"
import { Project } from "@vibest/core/project"
import { locateProject, resolveProject } from "@vibest/core/project-identity"
import { HARNESS_EXIT_WAIT, stopAgent } from "@vibest/core/remove"
import { Restarting } from "@vibest/core/restarting"
import { envelope } from "@vibest/core/results"
import {
  agentState,
  type Machine,
  machinesListing,
  NoRuntime,
  Runtimes,
  type Runtime,
  type Terminal,
} from "@vibest/core/runtimes"
import { NoSuchSession, runtimeEnv, type SessionView, Sessions } from "@vibest/core/sessions"
import { Subscriptions } from "@vibest/core/subscriptions/service"
import { NotInRepository } from "@vibest/core/worktree"
import {
  AGENT_HEADER,
  CALLER_HEADER,
  CWD_HEADER,
  HARNESS_HEADER,
  HARNESS_SESSION_HEADER,
  PLUGIN_VERSION_HEADER,
  PROJECT_HEADER,
  PROTOCOL,
  PROTOCOL_HEADER,
  protocolMismatch,
  REPOSITORY_HEADER,
  RUNTIME_HEADER,
  SESSION_HEADER,
} from "@vibest/protocol/protocol"
import {
  ACCESS,
  Admission,
  Caller,
  CallerGate,
  CAPABILITIES,
  DaemonBusy,
  type DaemonIdentity,
  DaemonStopping,
  Forbidden,
  InvalidCaller,
  VibestRpcs,
  ProtocolGate,
  WatchLagged,
  type WatchEvent,
  type WatchSession,
  ProtocolRejected,
  VERSION,
  WrongInstance,
  type CallerShape,
  type SessionInfo,
} from "@vibest/protocol/rpc"
import { HARNESS_IDS, LaunchFailed, NoHarnessChosen, type AgentStatus } from "@vibest/schema/session"
import { RuntimeUnreachable } from "@vibest/schema/session"
import { Clock, Context, Deferred, Duration, Effect, FileSystem, Layer, Option, Path, Queue, Stream } from "effect"
import * as Headers from "effect/http/Headers"
import { ChildProcessSpawner } from "effect/process"
import { RpcSerialization, RpcServer } from "effect/rpc"

import * as Hooks from "./hooks.ts"

const placeOf = (kind: string, address: RuntimeAddress) =>
  address.id !== "" ? `${kind} terminal ${address.id}` : `${kind} (no terminal)`

const sameCoordinator = (
  current: { readonly runtime: string | null; readonly address: RuntimeAddress | null } | undefined,
  runtime: string,
  address: string,
) => {
  const place = current?.address
  return (
    current?.runtime === runtime &&
    place !== null &&
    place !== undefined &&
    place.id !== "" &&
    encodeAddress(place) === address
  )
}

const LS_TASK = 500
const taskForLs = (task: string | null) =>
  task !== null && task.length > LS_TASK ? `${task.slice(0, LS_TASK - 1)}…` : task

export const toInfo = (session: SessionView, brief?: SessionBrief): SessionInfo => ({
  id: session.id,
  name: session.name,
  agent: session.agent,
  harness: session.harnessId,
  provider: session.provider,
  model: session.model,
  status: session.status,
  startedAt: session.startedAt,
  exitedAt: session.exitedAt,
  turnState: session.turnState,
  projectId: session.projectId,
  runtime: session.runtime,
  address: session.address,
  worktree: session.worktree,
  repositoryRoot: session.repositoryRoot ?? null,
  git: session.git ?? null,
  ...(session.metadata.routing ? { routing: session.metadata.routing } : {}),
  createdAt: session.createdAt,
  lastActive: session.lastActive,
  task: brief?.task ?? null,
  latest: brief?.latest ?? null,
})

const mainInfo = (m: CoordinatorRow, status: AgentStatus): SessionInfo => ({
  id: m.id,
  name: "main",
  agent: "main",
  harness: m.harnessId,
  provider: m.provider,
  model: m.model,
  status,
  startedAt: null,
  exitedAt: null,
  turnState: "none",
  projectId: m.projectId,
  runtime: m.runtime ?? "",
  address: m.address ?? { machine: "local", id: "" },
  worktree: m.projectDirectory ?? "",
  repositoryRoot: m.projectDirectory ?? null,
  git: null,
  ...(m.routing ? { routing: m.routing } : {}),
  createdAt: m.createdAt,
  lastActive: m.createdAt,
  task: null,
  latest: null,
})

const mainStatus = (h: Runtime, terminal: Terminal): Effect.Effect<AgentStatus> =>
  Effect.gen(function* () {
    const seen = yield* agentState(h, terminal).pipe(Effect.option)
    if (Option.isSome(seen) && seen.value !== "absent") return seen.value
    return yield* coordinatorIdle(h, terminal).pipe(
      Effect.map((presence) => (presence === "busy" ? "working" : presence === "idle" ? "idle" : "unknown")),
      Effect.catchTag("RuntimeError", () => Effect.succeed("unknown" as AgentStatus)),
    )
  })

type Access = typeof ACCESS
type MethodOf<A> = { [K in keyof Access]: Access[K] extends A ? K : never }[keyof Access]

const defaultSessionName = (prompt: string) => (prompt.trim().split("\n")[0] ?? "").slice(0, 40) || "task"

export const Identity = Context.Reference<DaemonIdentity>("vibest/DaemonIdentity", { defaultValue: () => ({}) })

export const Shutdown = Context.Reference<Deferred.Deferred<void>>("vibest/DaemonShutdown", {
  defaultValue: () => Deferred.makeUnsafe<void>(),
})

export type MainEnv = Map<string, { readonly sessionId: string; readonly env: Readonly<Record<string, string>> }>
export const MainEnv = Context.Reference<MainEnv>("vibest/MainEnv", { defaultValue: () => new Map() })
export const HANDOFF_ENV = "VIBEST_HANDOFF_ENV"

const envOffArgv = (argv: ReadonlyArray<string>) => {
  const command: Array<string> = []
  const env: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const next = argv[i + 1]
    if (argv[i] === "--env" && next !== undefined && next.includes("=")) {
      const eq = next.indexOf("=")
      const key = next.slice(0, eq)
      if (key !== "") {
        env[key] = next.slice(eq + 1)
        i++
        continue
      }
    }
    command.push(argv[i]!)
  }
  return { command, env }
}

export const DRAIN_TIMEOUT = Duration.seconds(5)
export const PRESENT_TIMEOUT = Duration.seconds(5)

export const WATCH_BACKLOG = 10_000

const SETTLEMENTS: ReadonlySet<string> = new Set(["TurnEnd", "Prompt"])

export const AdmissionLive = Layer.effect(
  Admission,
  Effect.gen(function* () {
    const drain = yield* Drain
    return Admission.of((effect, { rpc }) =>
      Effect.acquireUseRelease(
        drain.admit(rpc._tag, SETTLEMENTS.has(rpc._tag)),
        (leave) => (leave ? effect : Effect.fail(new DaemonStopping({ method: rpc._tag }))),
        (leave) => leave ?? Effect.void,
      ),
    )
  }),
)

const header = (headers: Headers.Headers, name: string) => Headers.get(headers, name)

const noteConversation = (db: Db["Service"], headers: Headers.Headers, row: { id: string; harness: string }) =>
  Effect.gen(function* () {
    const conversation = Option.getOrUndefined(header(headers, HARNESS_SESSION_HEADER))
    if (!conversation || Option.getOrUndefined(header(headers, HARNESS_HEADER)) !== row.harness) return
    if (yield* db.noteHarnessSession(row.id, conversation))
      yield* Effect.logInfo(`session ${row.id} is in conversation ${conversation}`)
  })

const noteOpen = (db: Db["Service"], headers: Headers.Headers, sessionId: string) =>
  Effect.gen(function* () {
    if (Option.getOrUndefined(header(headers, SESSION_HEADER)) !== sessionId) return
    const row = yield* db.sessionIdentity(sessionId)
    if (row && Option.getOrUndefined(header(headers, PROJECT_HEADER)) === row.projectId)
      yield* noteConversation(db, headers, row)
  })

const resolveCaller = (db: Db["Service"], headers: Headers.Headers, method: string) =>
  Effect.gen(function* () {
    const kind = header(headers, CALLER_HEADER)
    const sessionId = header(headers, SESSION_HEADER)
    const repository = header(headers, REPOSITORY_HEADER)
    const bad = (message: string) => new InvalidCaller({ method, message })
    if (kind._tag === "None")
      return yield* bad(`${method} needs an ${CALLER_HEADER} header (cli or session); it does not default to cli`)
    if (kind.value === "cli") {
      if (sessionId._tag === "Some") return yield* bad(`${method} claims cli and a session id`)
      if (repository._tag === "None" || repository.value.trim() === "")
        return yield* bad(`${method} claims cli without a repository`)
      return { _tag: "Cli", repositoryRoot: repository.value } satisfies CallerShape
    }
    if (kind.value === "session") {
      if (sessionId._tag === "None" || sessionId.value.trim() === "")
        return yield* bad(`${method} claims session without a session id`)
      if (repository._tag === "Some" && repository.value.trim() === "")
        return yield* bad(`${method} has an empty repository`)
      const row = yield* db.sessionIdentity(sessionId.value)
      if (!row) return yield* new NoSuchSession({ id: sessionId.value, message: `no session ${sessionId.value}` })
      const project = header(headers, PROJECT_HEADER)
      if (project._tag === "None")
        return yield* bad(`${method} claims session ${row.id} without ${PROJECT_HEADER} (VIBEST_PROJECT_ID)`)
      if (project.value !== row.projectId)
        return yield* bad(`${method} claims project ${project.value}; session ${row.id} is in project ${row.projectId}`)
      yield* noteConversation(db, headers, row)
      if (row.agent === "coordinator") {
        return {
          _tag: "Coordinator",
          sessionId: row.id,
          projectId: row.projectId,
          ...(repository._tag === "Some" ? { repositoryRoot: repository.value } : {}),
        } satisfies CallerShape
      }
      if (repository._tag === "Some") return yield* bad(`${method} is a session; a repository is not its identity`)
      return { _tag: "Session", sessionId: row.id, projectId: row.projectId } satisfies CallerShape
    }
    return yield* bad(`${method} has caller ${kind.value}; expected cli or session`)
  })

export const noteIntegration = (db: Db["Service"], read: (name: string) => string | undefined): Effect.Effect<void> =>
  Effect.gen(function* () {
    const sessionId = read(SESSION_HEADER)
    const version = read(PLUGIN_VERSION_HEADER)
    if (!sessionId || !version) return
    const protocol = Number(read(PROTOCOL_HEADER) ?? "0")
    if (yield* db.noteIntegration(sessionId, { version, protocol: Number.isFinite(protocol) ? protocol : 0 }))
      yield* Effect.logInfo(`session ${sessionId} runs integration ${version} (protocol ${protocol})`).pipe(
        Effect.annotateLogs({
          agent: read(AGENT_HEADER) ?? "",
          harness: read(HARNESS_HEADER) ?? "",
          cwd: decodeURIComponent(read(CWD_HEADER) ?? ""),
          runtime: read(RUNTIME_HEADER) ?? "",
        }),
      )
  })

export const ProtocolGateLive = Layer.effect(
  ProtocolGate,
  Effect.gen(function* () {
    const db = yield* Db
    return ProtocolGate.of((effect, { headers, rpc }) =>
      Effect.gen(function* () {
        yield* noteIntegration(db, (name) => Option.getOrUndefined(header(headers, name)))
        const protocol = header(headers, PROTOCOL_HEADER)
        if (protocol._tag === "None" || protocol.value !== String(PROTOCOL)) {
          const sent = protocol._tag === "None" ? null : protocol.value
          return yield* new ProtocolRejected({
            method: rpc._tag,
            protocol: sent,
            mismatch: protocolMismatch(
              sent === null ? undefined : Number(sent),
              PROTOCOL,
              VERSION,
              Option.getOrUndefined(header(headers, PLUGIN_VERSION_HEADER)),
            ),
          })
        }
        return yield* effect
      }),
    )
  }),
)

export const CallerGateLive = Layer.effect(
  CallerGate,
  Effect.gen(function* () {
    const db = yield* Db
    return CallerGate.of((effect, { headers, rpc }) =>
      resolveCaller(db, headers, rpc._tag).pipe(
        Effect.flatMap((caller) => Effect.provideService(effect, Caller, caller)),
      ),
    )
  }),
)

export const handlers = VibestRpcs.toLayer(
  Effect.gen(function* () {
    const sessions = yield* Sessions
    const inbox = yield* Inbox
    const db = yield* Db
    const restarting = yield* Restarting
    const runtimes = yield* Runtimes
    const project = yield* Project
    const layout = yield* Layout
    const plugins = yield* Plugins
    const subscriptions = yield* Subscriptions
    const identity = yield* Identity
    const shutdown = yield* Shutdown
    const mainEnv = yield* MainEnv
    const drain = yield* Drain
    const bus = yield* Bus
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const harnesses = yield* Harnesses
    const files = yield* Effect.context<FileSystem.FileSystem | Path.Path | Layout>()

    const hook = <E>(
      sessionId: string,
      harness: string,
      headers: Headers.Headers,
      run: (who: Hooks.HookCaller) => Effect.Effect<void, E, FileSystem.FileSystem | Path.Path | Layout>,
    ) =>
      Effect.gen(function* () {
        yield* noteOpen(db, headers, sessionId)
        const row = yield* db.sessionIdentity(sessionId)
        if (!row || row.harness !== harness) return
        yield* run(row)
      }).pipe(Effect.provideContext(files), Effect.orDie)

    const agent = (method: MethodOf<"agent" | "owner">) =>
      Effect.gen(function* () {
        const c = yield* Caller
        if (c._tag === "Session")
          return yield* new Forbidden({
            method,
            message: `session ${c.sessionId} may not call ${method}; sessions only report to their coordinator (vibest report)`,
          })
        return c
      })

    const managed = (method: MethodOf<"owner">, input: string) =>
      Effect.gen(function* () {
        const c = yield* agent(method)
        const id = yield* db.resolveSession(input)
        const session = yield* db.getSession(id)
        if (!session) return yield* new NoSuchSession({ id, message: `no session ${id}` })
        if (c._tag === "Coordinator" && session.projectId !== c.projectId)
          return yield* new Forbidden({
            method,
            message: `${id} belongs to another coordinator; only it or the user may manage it`,
          })
        return id
      })

    const atProject = (directory: string) =>
      locateProject(directory).pipe(
        Effect.catchIf(
          (error) => error._tag !== "NotInRepository",
          (error) => Effect.die(error),
        ),
      )
    const resolveAt = (directory: string) => atProject(directory).pipe(Effect.flatMap((at) => resolveProject(db, at)))
    const findAt = (directory: string) => atProject(directory).pipe(Effect.flatMap((at) => db.projectAt(at.root)))

    const projectOf = (c: Extract<CallerShape, { _tag: "Cli" | "Coordinator" }>, method: string) =>
      Effect.gen(function* () {
        if (c._tag === "Cli") return yield* resolveAt(c.repositoryRoot)
        const directory = yield* db.projectDirectory(c.projectId)
        if (directory !== undefined) return { id: c.projectId, directory }
        if (c.repositoryRoot === undefined) return yield* new NotInRepository({ path: `project ${c.projectId}` })
        const here = yield* resolveAt(c.repositoryRoot)
        if (here.id !== c.projectId)
          return yield* new Forbidden({
            method,
            message:
              "a main agent only works in its own project: cd into the directory where vibest was started and run it again",
          })
        return here
      })

    const scope = (method: MethodOf<"agent">) => agent(method).pipe(Effect.flatMap((c) => projectOf(c, method)))

    const machineOf = (machine: { readonly id: string; readonly target?: string | undefined } | undefined): Machine =>
      machine === undefined
        ? { id: "local" }
        : { id: machine.id, ...(machine.target !== undefined ? { target: machine.target } : {}) }
    const projectLocked = keyedLock<string>()

    const runningCoordinator = (projectId: string, terminal: string) =>
      Effect.gen(function* () {
        const coord = yield* db.coordinatorOf(projectId)
        if (!coord?.address || coord.address.id === "" || !coord.runtime) return null
        if (coord.address.id === terminal) return null
        if (!restarting.has(coord.id)) {
          const h = yield* runtimes.route(coord.runtime).pipe(Effect.option)
          if (Option.isNone(h)) return null
          const presence = yield* coordinatorIdle(h.value, coord.address).pipe(Effect.option)
          if (Option.isNone(presence) || (presence.value !== "idle" && presence.value !== "busy")) return null
        }
        return {
          harness: coord.harnessId,
          place: placeOf(coord.runtime, coord.address),
          runtime: coord.runtime,
          address: encodeAddress(coord.address),
        }
      })
    const listedMain = (m: CoordinatorRow | undefined) =>
      Effect.gen(function* () {
        if (!m?.runtime || !m.address || m.address.id === "") return undefined
        const h = yield* runtimes.route(m.runtime).pipe(Effect.option)
        const status = Option.isNone(h) ? "unknown" : yield* mainStatus(h.value, m.address)
        return mainInfo(m, status)
      })

    const listedRows = (rows: ReadonlyArray<SessionView>) =>
      Effect.map(db.sessionBriefs(rows.map((row) => row.id)), (briefs) =>
        rows.map((row) => {
          const brief = briefs.get(row.id)
          return { ...toInfo(row, brief), task: taskForLs(brief?.task ?? null) }
        }),
      )

    const listed = (projectId: string | undefined, stopped: boolean) =>
      Effect.gen(function* () {
        const rows = yield* sessions.list({ ...(projectId === undefined ? {} : { projectId }), stopped })
        const mains = projectId === undefined ? yield* db.coordinators : [yield* db.coordinatorOf(projectId)]
        return [
          ...(yield* Effect.forEach(mains, listedMain)).flatMap((m) => (m ? [m] : [])),
          ...(yield* listedRows(rows)),
        ]
      })

    const withParents = (infos: ReadonlyArray<SessionInfo>) =>
      Effect.map(db.sessionParents(infos.map((info) => info.id)), (parents) =>
        infos.map((info): WatchSession => ({ ...info, parentId: parents.get(info.id) ?? null })),
      )

    const watchSession = (id: string) =>
      Effect.gen(function* () {
        const identity = yield* db.sessionIdentity(id)
        if (identity === undefined) return []
        const ended: WatchEvent = { _tag: "SessionEnded", id, projectId: identity.projectId }
        const info =
          identity.agent === "coordinator"
            ? yield* listedMain(yield* db.coordinatorOf(identity.projectId))
            : yield* Effect.gen(function* () {
                const row = yield* db.getSession(id)
                if (row === undefined || row.agent === "main" || row.exitedAt !== null) return undefined
                const view = yield* sessions
                  .get(id)
                  .pipe(
                    Effect.catchTag("NoSuchSession", () =>
                      Effect.succeed({ ...row, worktree: "", repositoryRoot: undefined, git: undefined }),
                    ),
                  )
                return (yield* listedRows([view]))[0]
              })
        if (info === undefined || info.id !== id) return [ended]
        const [session] = yield* withParents([info])
        return [{ _tag: "Session", session: session! } satisfies WatchEvent]
      })

    const watchProject = (id: string) =>
      Effect.map(db.watchProjects(id), (rows) => rows.map((project): WatchEvent => ({ _tag: "Project", project })))

    const watchDeltas = (events: ReadonlyArray<EngineEvent>) =>
      Effect.gen(function* () {
        const projectIds = new Set<string>()
        const sessionIds = new Set<string>()
        for (const event of events) {
          if ("id" in event || event.type === "live.session" || event.type === "live.turn_start")
            sessionIds.add(event.sessionId)
          else if (event.type === "live.project") projectIds.add(event.projectId)
          else if (event.type === "live.state" || event.type === "live.exited") {
            const project = yield* db.coordinatorAt(event.runtime, event.terminal)
            const main = project === undefined ? undefined : yield* db.coordinatorOf(project)
            if (main !== undefined) sessionIds.add(main.id)
          } else if (event.type === "live.reset")
            for (const info of yield* listed(undefined, false))
              if (info.runtime === event.runtime) sessionIds.add(info.id)
        }
        return [
          ...(yield* Effect.forEach(projectIds, watchProject)).flat(),
          ...(yield* Effect.forEach(sessionIds, watchSession)).flat(),
        ]
      })

    const onlyRuntime = Effect.flatMap(runtimes.all, (all) => Effect.succeed(all.length === 1 ? all[0] : undefined))

    const stopOnce = <E, R>(instance: string, method: string, before: Effect.Effect<void, E, R>) =>
      Effect.gen(function* () {
        if (!(yield* drain.begin)) return yield* new DaemonStopping({ method })
        let last: Array<{ id: string; reason: string }> = []
        const blockers = Effect.gen(function* () {
          last = (yield* drain.pending).map((id) => ({ id, reason: "daemon operation still running" }))
          if (last.length > 0) return last
          last = [{ id: "inbox", reason: "checking unsettled delivery" }]
          last = (yield* db.sendingInbox).map((row) => ({
            id: `inbox ${row.id}`,
            reason: `${row.kind} for session ${row.sessionId}: delivery not settled`,
          }))
          return last
        })
        return yield* Effect.gen(function* () {
          const none = blockers.pipe(
            Effect.map((pending) => (pending.length === 0 ? Option.some(true) : Option.none())),
          )
          const idle = yield* awaitEvent(
            none,
            (event) =>
              event.type === "live.drain" || event.type === "inbox.status" ? none : Effect.succeed(Option.none()),
            DRAIN_TIMEOUT,
            Effect.map(none, Option.isSome),
          ).pipe(Effect.provideService(Bus, bus))
          if (!idle) return yield* new DaemonBusy({ blockers: last })
          yield* before
          yield* Effect.uninterruptible(
            Effect.gen(function* () {
              if (!(yield* drain.accept))
                return yield* new DaemonBusy({
                  blockers: (yield* drain.pending).map((id) => ({ id, reason: "daemon operation still running" })),
                })
              yield* Deferred.succeed(shutdown, undefined)
            }),
          )
          return { instance }
        }).pipe(Effect.ensuring(drain.reopen))
      })

    const cliOnly = (method: MethodOf<"cli">) =>
      Effect.flatMap(Caller, (c) =>
        c._tag === "Cli"
          ? Effect.void
          : Effect.fail(new Forbidden({ method, message: `only the user runs ${method}` })),
      )

    const self = (method: MethodOf<"self">, id: string) =>
      Effect.gen(function* () {
        const c = yield* Caller
        if ((c._tag === "Session" || c._tag === "Coordinator") && c.sessionId === id) return undefined
        if (c._tag === "Cli") {
          const found = Option.getOrUndefined(yield* findAt(c.repositoryRoot).pipe(Effect.option))
          const main = found === undefined ? undefined : yield* db.coordinatorOf(found.id)
          if (main?.id === id) return main
        }
        return yield* new Forbidden({ method, message: `${method} ${id} runs only in that agent's own terminal` })
      })

    return VibestRpcs.of({
      Ping: () =>
        machinesListing(runtimes, []).pipe(
          Effect.map((machines) =>
            machines.flatMap((machine) =>
              machine.runtimes.map((r) => ({
                kind: r.kind,
                status: r.status,
                ...(r.reason !== undefined ? { reason: r.reason } : {}),
              })),
            ),
          ),
          Effect.map((rows) => ({
            protocol: PROTOCOL,
            version: VERSION,
            runtimes: rows,
            ...identity,
            capabilities: CAPABILITIES,
          })),
        ),

      Spawn: (input) =>
        Effect.gen(function* () {
          const c = yield* agent("Spawn")
          if (input.agent === "coordinator" || input.agent === "main")
            return yield* new Forbidden({
              method: "Spawn",
              message: `${input.agent} is reserved for the main agent (vibest)`,
            })
          const project = yield* projectOf(c, "Spawn")
          return yield* sessions.spawn({
            machine: machineOf(input.machine),
            root: project.directory,
            projectId: project.id,
            name: input.name ?? defaultSessionName(input.prompt),
            prompt: input.prompt,
            harness: input.harness,
            provider: input.provider,
            model: input.model,
            env: input.env,
            agent: input.agent,
            peer: input.peer === undefined ? undefined : yield* db.resolveSession(input.peer),
            archive: input.archive,
            parentSessionId: c._tag === "Coordinator" ? c.sessionId : undefined,
            request: input.request,
          })
        }),

      "Caller.Keys": () => plugins.list.pipe(Effect.andThen(runtimes.all), Effect.map(callerKeys)),
      "Caller.Detect": (input) =>
        Effect.gen(function* () {
          if (!(yield* plugins.settled)) return unresolved("runtime plugins are still activating; retry")
          const snapshot = yield* runtimes.all
          const result = yield* detectCaller(snapshot, input)
          return snapshot === (yield* runtimes.all)
            ? result
            : unresolved("runtime plugins changed during detection; retry")
        }),
      Plugins: () => plugins.list,

      "Runtimes.Doctor": ({ harnesses }) =>
        Effect.flatMap(runtimes.statuses({ id: "local" }), (rows) =>
          Effect.forEach(rows, ({ runtime, status }) =>
            (runtime.doctor
              ? runtime.doctor({ id: "local" }, harnesses)
              : Effect.succeed({ name: runtime.kind, checks: [] })
            ).pipe(
              Effect.map((report) => ({
                kind: runtime.kind,
                status: status.status,
                ...("reason" in status ? { reason: status.reason } : {}),
                name: report.name,
                checks: report.checks,
              })),
            ),
          ),
        ),

      Subscriptions: () => subscriptions.list,

      Republish: () => sessions.republish,

      Launch: ({ argv, focus, machine, runtime }) =>
        Effect.gen(function* () {
          const { id, directory: root } = yield* scope("Launch")
          const { command, env } = envOffArgv(argv)
          const passed = Object.keys(env).length > 0 ? env : undefined
          const at = machineOf(machine)
          const current = yield* db.coordinatorOf(id)
          const decision = yield* plugins.start({
            project: root,
            agentType: "main",
            parentSessionId: undefined,
            prompt: "",
            harness: undefined,
            provider: undefined,
            model: undefined,
            harnesses: yield* harnessOptions,
            attempts: [],
            machine: { id: at.id },
            runtime,
            parentRuntime: current?.runtime ?? undefined,
            machines: yield* machinesListing(runtimes, [...HARNESS_IDS]).pipe(Effect.orElseSucceed(() => [])),
          })
          if (decision.runtime === undefined) {
            const loaded = (yield* runtimes.all).map((h) => h.kind)
            return yield* new NoRuntime({
              message: `no terminal runtime was chosen for the main agent${loaded.length === 0 ? "" : `; loaded: ${loaded.join(", ")}`}`,
            })
          }
          const rt = yield* runtimes.route(decision.runtime)
          yield* runtimes.online(rt, { id: decision.machine.id })
          const terminal = yield* Launch.openInParentWorkspace(rt, at, {
            root,
            label: "vibest",
            home: layout.home,
            focus,
            ...(passed !== undefined ? { env: { [Launch.MAIN_ENV]: JSON.stringify(passed) } } : {}),
          })
          const run = rt.run
          if (run === undefined) {
            yield* rt.close(terminal).pipe(Effect.ignore)
            return yield* new LaunchFailed({ message: "this runtime cannot type a command into the pane it opened" })
          }
          yield* run(terminal, Launch.inParent(command, root, rt.kind)).pipe(
            Effect.catch((error) =>
              rt
                .close(terminal)
                .pipe(Effect.ignore, Effect.andThen(Effect.fail(new LaunchFailed({ message: error.message })))),
            ),
          )
          return {
            runtime: rt.kind,
            terminal: terminal.id,
            place: placeOf(rt.kind, terminal),
            attach: rt.attach?.(at) ?? null,
          }
        }),

      Send: ({ id: input, message, request }) =>
        managed("Send", input).pipe(
          Effect.flatMap((id) => sessions.send(id, message, request).pipe(Effect.as({ id }))),
        ),
      Interrupt: ({ id: input }) =>
        managed("Interrupt", input).pipe(
          Effect.flatMap((id) => sessions.interrupt(id).pipe(Effect.map((out) => ({ id, ...out })))),
        ),
      Remove: ({ id: input, keepWorktree }) =>
        managed("Remove", input).pipe(
          Effect.flatMap((id) =>
            sessions
              .remove(id, { keepWorktree })
              .pipe(
                Effect.catchTag("RuntimeError", (e) =>
                  e.code === "unreachable"
                    ? Effect.fail(new RuntimeUnreachable({ session: id, message: e.message }))
                    : Effect.die(e),
                ),
              ),
          ),
          Effect.map((out) => out ?? null),
        ),

      List: ({ stopped, all }) =>
        Effect.gen(function* () {
          const c = yield* agent("List")
          const projectId =
            c._tag === "Coordinator"
              ? c.projectId
              : all === true
                ? undefined
                : yield* findAt(c.repositoryRoot ?? "").pipe(
                    Effect.map((found) => found?.id),
                    Effect.catchTag("NotInRepository", () => Effect.succeed(undefined)),
                  )
          if (projectId === undefined && all !== true) return []
          return yield* listed(projectId, stopped === true)
        }),

      Get: ({ id: input }) =>
        Effect.gen(function* () {
          yield* agent("Get")
          const id = yield* db.resolveSession(input)
          const row = yield* sessions.get(id)
          const session = toInfo(row, (yield* db.sessionBriefs([id])).get(id))
          return { ...session, result: (yield* db.latestInbox(id, "result")) ?? null }
        }),

      Peek: ({ id: input, lines }) =>
        managed("Peek", input).pipe(
          Effect.flatMap((id) => sessions.peek(id, lines ?? 30)),
          Effect.map((text) => ({ text })),
        ),

      Report: ({ message }) =>
        Effect.gen(function* () {
          const owner = yield* Caller
          if (owner._tag !== "Session")
            return yield* new Forbidden({
              method: "Report",
              message: "only a session reports (vibest report runs with VIBEST_SESSION_ID)",
            })
          const session = yield* db.getSession(owner.sessionId)
          if (!session)
            return yield* new NoSuchSession({ id: owner.sessionId, message: `no session ${owner.sessionId}` })
          yield* inbox.enqueue({
            sessionId: session.id,
            kind: "report",
            message: envelope(
              "agent-message",
              [
                ["agent-id", session.id],
                ["summary", `Agent "${session.name}" sent a message before finishing`],
              ],
              ["message", message],
            ),
            details: {},
          })
        }),

      Watch: () =>
        Stream.unwrap(
          Effect.gen(function* () {
            yield* cliOnly("Watch")
            const subscription = yield* bus.subscribe
            const backlog = yield* Queue.bounded<EngineEvent, WatchLagged>(WATCH_BACKLOG)
            yield* Stream.fromSubscription(subscription).pipe(
              Stream.runForEach((event) =>
                Queue.offerUnsafe(backlog, event)
                  ? Effect.void
                  : Queue.fail(
                      backlog,
                      new WatchLagged({
                        message: `Watch fell ${WATCH_BACKLOG} events behind; reconnect for a new Snapshot`,
                      }),
                    ),
              ),
              Effect.forkScoped,
            )
            const sessionRows = yield* withParents(yield* listed(undefined, false))
            const snapshot: WatchEvent = {
              _tag: "Snapshot",
              projects: yield* db.watchProjects(),
              sessions: sessionRows,
            }
            return Stream.concat(
              Stream.make(snapshot),
              Stream.fromEffectRepeat(Queue.takeAll(backlog).pipe(Effect.flatMap(watchDeltas))).pipe(
                Stream.flattenIterable,
              ),
            )
          }),
        ),

      "Inbox.Subscribe": () =>
        Stream.unwrap(
          Effect.gen(function* () {
            const c = yield* Caller
            if (c._tag !== "Coordinator")
              return yield* new Forbidden({
                method: "Inbox.Subscribe",
                message: "Inbox.Subscribe is the coordinator's",
              })
            return inbox.stream(c.projectId)
          }),
        ),

      TurnEnd: ({ sessionId, harness, event }, { headers }) =>
        hook(sessionId, harness, headers, (who) => Hooks.turnEnd(db, harnesses.get(harness), who, event)),

      Prompt: ({ sessionId, harness, event }, { headers }) =>
        hook(sessionId, harness, headers, (who) => Hooks.prompt(sessions, harnesses.get(harness), who, event)),

      "Project.StartMain": ({ harness, provider, model, runtime, callerRuntime, callerTerminal }) =>
        Effect.gen(function* () {
          const { id, directory: root } = yield* scope("Project.StartMain")
          const current = yield* db.coordinatorOf(id)
          const decision = yield* plugins.start({
            project: root,
            agentType: "main",
            parentSessionId: undefined,
            prompt: "",
            harness: harness ?? current?.harnessId,
            provider,
            model,
            harnesses: yield* harnessOptions,
            attempts: [],
            machine: { id: "local" },
            runtime,
            parentRuntime: callerRuntime,
            machines: yield* machinesListing(runtimes, [...HARNESS_IDS]).pipe(Effect.orElseSucceed(() => [])),
          })
          if (decision.harness === undefined) return yield* new NoHarnessChosen()
          if (!isHarnessId(decision.harness))
            return yield* new HarnessUnavailable({
              harness: decision.harness,
              message: `unknown harness ${decision.harness} (routed: ${describeSpawn({ ...decision, harness: decision.harness })})`,
            })
          if (decision.runtime === undefined)
            return yield* new NoRuntime({ message: "no terminal runtime was chosen for the main agent" })
          const rt = yield* runtimes.route(decision.runtime)
          yield* runtimes.online(
            rt,
            { id: decision.machine.id },
            rt.kind === callerRuntime ? callerTerminal : undefined,
          )
          return { ...decision, harness: decision.harness, runtime: rt.kind }
        }),

      "Project.Open": ({ move }) =>
        Effect.gen(function* () {
          yield* cliOnly("Project.Open")
          const c = yield* Caller
          if (c._tag !== "Cli")
            return yield* new Forbidden({ method: "Project.Open", message: "only the user runs Project.Open" })
          const project = yield* resolveProject(db, yield* atProject(c.repositoryRoot), move)
          return {
            projectId: project.id,
            directory: project.directory,
            ...("moved" in project ? { moved: project.moved } : {}),
            ...("candidates" in project ? { candidates: project.candidates } : {}),
          }
        }),

      "Project.CoordinatorSession": ({
        harness,
        fresh,
        terminal,
        machine,
        runtime,
        provider,
        model,
        routing,
        pid,
        env,
      }) =>
        Effect.gen(function* () {
          const { id: projectId, directory } = yield* scope("Project.CoordinatorSession")
          const kind = runtime ?? (yield* onlyRuntime)?.kind
          if (kind === undefined)
            return yield* new InvalidCaller({
              method: "Project.CoordinatorSession",
              message: "Project.CoordinatorSession needs the runtime the main agent runs in",
            })
          return yield* projectLocked.withLock(projectId)(
            Effect.gen(function* () {
              const running = yield* runningCoordinator(projectId, terminal)
              if (running)
                return yield* new Forbidden({
                  method: "Project.CoordinatorSession",
                  message: `the main agent (${running.harness}) is still running in ${running.place}, and a project has one main agent; exit it there first, or run vibest here on an interactive terminal and answer y to move it here`,
                })
              const saved = yield* db.coordinatorLaunch(
                projectId,
                harness,
                fresh,
                { runtime: kind, address: { machine: machineOf(machine).id, id: terminal } },
                { provider, model, routing, pid, projectDirectory: directory },
              )
              if (env && Object.keys(env).length > 0) mainEnv.set(projectId, { sessionId: saved.sessionId, env })
              else mainEnv.delete(projectId)
              const rt = Option.getOrUndefined(yield* runtimes.route(kind).pipe(Effect.option))
              if (rt?.present !== undefined)
                yield* rt
                  .present(
                    { machine: machineOf(machine).id, id: terminal },
                    { mainSession: saved.sessionId, projectId },
                  )
                  .pipe(Effect.timeout(PRESENT_TIMEOUT), Effect.ignore)
              return { ...saved, runtime: runtimeEnv(kind, { machine: machineOf(machine).id, id: terminal }) }
            }),
          )
        }),

      "Project.RunningCoordinator": ({ terminal }) =>
        scope("Project.RunningCoordinator").pipe(Effect.flatMap(({ id }) => runningCoordinator(id, terminal))),

      "Project.StopCoordinator": ({ runtime, address }) =>
        Effect.gen(function* () {
          const { id: projectId } = yield* scope("Project.StopCoordinator")
          return yield* projectLocked.withLock(projectId)(
            Effect.gen(function* () {
              const coord = yield* db.coordinatorOf(projectId)
              const place = coord?.address
              if (!coord?.runtime || !place || place.id === "" || !sameCoordinator(coord, runtime, address))
                return { result: "moved" as const }
              if (restarting.has(coord.id))
                return {
                  result: "unsupported" as const,
                  reason: "vibest update is restarting it there; run vibest again once it is ready",
                }
              const h = yield* runtimes
                .route(runtime)
                .pipe(
                  Effect.mapError((e) => new InvalidCaller({ method: "Project.StopCoordinator", message: e.message })),
                )
              return yield* stopAgent(h, place, {
                pid: coord.pid,
                detach: db.detachCoordinator(projectId, runtime, place),
                reattach: db.reattachCoordinator(projectId, runtime, place),
                wait: HARNESS_EXIT_WAIT,
              }).pipe(Effect.provideService(Bus, bus))
            }),
          )
        }),

      "Session.Start": ({ id }) =>
        Effect.gen(function* () {
          const main = yield* self("Session.Start", id)
          if (main === undefined)
            return yield* new NoSuchSession({
              id,
              message: `${id} is not a main agent; only a main agent starts this way`,
            })
          yield* db.patchLive(id, { ready: null })
          const kept = mainEnv.get(main.projectId)
          return {
            harness: main.harnessId,
            harnessSessionId: main.harnessSessionId,
            provider: main.provider,
            model: main.model,
            projectId: main.projectId,
            ...(main.runtime && main.address ? { runtime: runtimeEnv(main.runtime, main.address) } : {}),
            ...(kept?.sessionId === id ? { env: kept.env } : {}),
          }
        }),

      "Session.Ready": ({ id, pid }) =>
        Effect.gen(function* () {
          yield* self("Session.Ready", id)
          yield* db.patchLive(id, { ready: yield* Clock.currentTimeMillis, ...(pid === undefined ? {} : { pid }) })
        }),

      "Agents.Outdated": () => cliOnly("Agents.Outdated").pipe(Effect.andThen(sessions.outdated)),

      "Agents.Restart": ({ ids, after }) =>
        cliOnly("Agents.Restart").pipe(Effect.andThen(sessions.restartLater(ids, after))),

      CoordinatorSessionReady: ({ sessionId, harness, harnessSessionId }) =>
        db.reportCoordinatorSession(sessionId, harness, harnessSessionId),
      "Project.Info": () => scope("Project.Info").pipe(Effect.flatMap(project.info)),
      "Project.Search": (input) => scope("Project.Search").pipe(Effect.flatMap((s) => project.search(s, input))),

      "Daemon.Stop": ({ instance }) =>
        Effect.gen(function* () {
          const c = yield* Caller
          if (c._tag !== "Cli")
            return yield* new Forbidden({
              method: "Daemon.Stop",
              message: "only the user stops vibestd (vibest daemon restart); an agent may not",
            })
          if (instance !== identity.instance)
            return yield* new WrongInstance({ expected: instance, actual: identity.instance ?? null })
          return yield* stopOnce(instance, "Daemon.Stop", Effect.void)
        }),

      "Daemon.Handoff": ({ instance, command }) =>
        Effect.gen(function* () {
          yield* cliOnly("Daemon.Handoff")
          if (instance !== identity.instance)
            return yield* new WrongInstance({ expected: instance, actual: identity.instance ?? null })
          const quoted = command.map(shellQuote).join(" ")
          const checked = yield* importCheck(command).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          )
          if (checked !== undefined)
            return yield* new LaunchFailed({
              message: `${quoted} cannot take over this vibestd (${checked}); it keeps running`,
            })
          return yield* stopOnce(
            instance,
            "Daemon.Handoff",
            spawnDaemon(command, ["--import"], { [HANDOFF_ENV]: JSON.stringify([...mainEnv]) }).pipe(
              Effect.mapError(
                (e) => new LaunchFailed({ message: `${quoted} did not start: ${e.message}; vibestd keeps running` }),
              ),
            ),
          )
        }),
    })
  }),
)

export const layer = RpcServer.layer(VibestRpcs).pipe(
  Layer.provide(Layer.mergeAll(handlers, AdmissionLive)),
  Layer.provide(CallerGateLive),
  Layer.provide(ProtocolGateLive),
  Layer.provide(RpcServer.layerProtocolSocketServer),
  Layer.provide(RpcSerialization.layerNdJsonRpc()),
)
