import { spawnDaemon } from "@vibest/client/client"
import { Agents } from "@vibest/core/agents"
import { type CoordinatorRow, Db, encodeAddress, type RuntimeAddress, type SessionBrief } from "@vibest/core/db"
import { Drain } from "@vibest/core/drain"
import { harnessOptions, Harnesses, HarnessUnavailable } from "@vibest/core/harness"
import { coordinatorIdle, Inbox } from "@vibest/core/inbox"
import { keyedLock } from "@vibest/core/keyed-lock"
import * as Launch from "@vibest/core/launch"
import { Layout, shellQuote } from "@vibest/core/paths"
import { describeSpawn, Plugins } from "@vibest/core/plugins"
import { Project } from "@vibest/core/project"
import { projectRoot } from "@vibest/core/project-create"
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
  Admission,
  Caller,
  CallerGate,
  DaemonBusy,
  type DaemonIdentity,
  DaemonStopping,
  Forbidden,
  InvalidCaller,
  VibestRpcs,
  ProtocolGate,
  ProtocolRejected,
  VERSION,
  WrongInstance,
  type CallerShape,
  type SessionInfo,
} from "@vibest/protocol/rpc"
import { LaunchFailed, NoHarnessChosen, type AgentStatus } from "@vibest/schema/session"
import { RuntimeUnreachable } from "@vibest/schema/session"
// vibestd's side of the RPC contract (SPEC §7): handlers over Sessions / Inbox / Project, served on a SocketServer
// (the unix socket comes from #platform). Caller and protocol are request headers, checked by middleware before the
// handler effect runs. Middleware must not call client.annotate: a later request on the same socket starts clean.
import { Context, Deferred, Duration, Effect, Layer, Option, Schedule, Stream } from "effect"
import * as Headers from "effect/http/Headers"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { RpcSerialization, RpcServer } from "effect/rpc"
import type { RpcGroup } from "effect/rpc"

const placeOf = (kind: string, address: RuntimeAddress) =>
  address.id !== "" ? `${kind} terminal ${address.id}` : `${kind} (no terminal)`

/** The project's coordinator row is still the one StopCoordinator was asked to stop. */
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

/** `vibest ls` shows at most this many characters of a task; the ellipsis is the last of them. `Get` is uncut. */
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

/** A Project's main agent as `vibest ls` shows it, with its live status read from the runtime (`mainStatus`). */
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

/**
 * The main agent's live status: what its runtime reports at its terminal (§3 `state`), else what its process state
 * says (`coordinatorIdle`'s fallback). `unknown` when the runtime cannot tell.
 */
const mainStatus = (h: Runtime, terminal: Terminal): Effect.Effect<AgentStatus> =>
  Effect.gen(function* () {
    const seen = yield* agentState(h, terminal).pipe(Effect.option)
    if (Option.isSome(seen) && seen.value !== "absent") return seen.value
    return yield* coordinatorIdle(h, terminal).pipe(
      Effect.map((presence) => (presence === "busy" ? "working" : presence === "idle" ? "idle" : "unknown")),
      Effect.catchTag("RuntimeError", () => Effect.succeed("unknown" as AgentStatus)),
    )
  })

/**
 * Who may call each method (SPEC §7). `open`: protocol only, no caller. `session`: a non-coordinator session only.
 * `spawner`: the command line, a coordinator, or a session whose agent definition `can.spawn` (a lead).
 * `agent`: a coordinator's or the command line's. `coordinator`: a coordinator only. `owner`: a coordinator of the
 * session's project, or the command line. `self`: a subagent's own terminal for its own id, or the command line at the
 * project's root for its main agent (its start after a restart). The table must list every method.
 */
const ACCESS = {
  Ping: "open",
  Plugins: "open",
  "Runtimes.Doctor": "open",
  Subscriptions: "open",
  Republish: "open",
  Report: "session",
  Spawn: "spawner",
  Launch: "agent",
  List: "spawner",
  Get: "spawner",
  "Project.CoordinatorSession": "agent",
  "Project.StartMain": "agent",
  "Project.RunningCoordinator": "agent",
  "Project.StopCoordinator": "agent",
  "Project.Info": "agent",
  "Project.List": "agent",
  "Project.Read": "agent",
  "Project.Search": "agent",
  "Project.Write": "agent",
  "Project.Delete": "agent",
  Send: "owner",
  Interrupt: "owner",
  Peek: "owner",
  Remove: "owner",
  "Daemon.Stop": "cli",
  "Daemon.Handoff": "cli",
  "Session.Start": "self",
  "Agents.Outdated": "cli",
  "Agents.Restart": "cli",
} as const satisfies Record<
  RpcGroup.Rpcs<typeof VibestRpcs>["_tag"],
  "open" | "session" | "spawner" | "agent" | "coordinator" | "owner" | "cli" | "self"
>
type Access = typeof ACCESS
type MethodOf<A> = { [K in keyof Access]: Access[K] extends A ? K : never }[keyof Access]

/** Default session name: the prompt's first line, shortened. */
const nameFrom = (prompt: string) => (prompt.trim().split("\n")[0] ?? "").slice(0, 40) || "task"

/** Ping's `capabilities`: the additive features this vibestd has (rpc.ts PingResult). */
export const CAPABILITIES = { http: true, handoff: true } as const

/** This vibestd's identity for Ping, set by Daemon.run; empty on a server a test runs without one. */
export const Identity = Context.Reference<DaemonIdentity>("vibest/DaemonIdentity", { defaultValue: () => ({}) })

/** Completed when a Daemon.Stop is accepted; Daemon.run waits for it, then closes the server, the lock last. */
export const Shutdown = Context.Reference<Deferred.Deferred<void>>("vibest/DaemonShutdown", {
  defaultValue: () => Deferred.makeUnsafe<void>(),
})

/**
 * Each project's main agent `vibest --env` values, in this vibestd's memory only (never stored, logged or sent as
 * telemetry): Session.Start hands them back for a restart in place. A handoff passes them to the next vibestd in its
 * process environment (VIBEST_HANDOFF_ENV), which `vibest daemon --import` reads and removes before anything starts.
 */
export type MainEnv = Map<number, { readonly sessionId: string; readonly env: Readonly<Record<string, string>> }>
export const MainEnv = Context.Reference<MainEnv>("vibest/MainEnv", { defaultValue: () => new Map() })
export const HANDOFF_ENV = "VIBEST_HANDOFF_ENV"

/** A bounded wait for daemon operations to drain, never for agents to finish their tasks. */
export const DRAIN_TIMEOUT = Duration.seconds(5)

/** Changes are counted until they end, failed or interrupted ones too; refused while a Stop drains. Only at the RPC entry; integration events (settlements) come over HTTP. */
export const AdmissionLive = Layer.effect(
  Admission,
  Effect.gen(function* () {
    const drain = yield* Drain
    return Admission.of((effect, { rpc }) =>
      Effect.acquireUseRelease(
        drain.admit(rpc._tag, false),
        (leave) => (leave ? effect : Effect.fail(new DaemonStopping({ method: rpc._tag }))),
        (leave) => leave ?? Effect.void,
      ),
    )
  }),
)

const header = (headers: Headers.Headers, name: string) => Headers.get(headers, name)

/**
 * The harness's conversation id from a session's request, latest wins (a /clear changes it); only from the session's own
 * harness, so an old process of another harness under this id changes nothing.
 */
const noteConversation = (db: Db["Service"], headers: Headers.Headers, row: { id: string; harness: string }) =>
  Effect.gen(function* () {
    const conversation = Option.getOrUndefined(header(headers, HARNESS_SESSION_HEADER))
    if (!conversation || Option.getOrUndefined(header(headers, HARNESS_HEADER)) !== row.harness) return
    if (yield* db.noteHarnessSession(row.id, conversation))
      yield* Effect.logInfo(`session ${row.id} is in conversation ${conversation}`)
  })

/** Missing, mixed, or malformed caller headers. Never becomes cli. */
const resolveCaller = (db: Db["Service"], agents: Agents["Service"], headers: Headers.Headers, method: string) =>
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
      // A session's environment names its project (VIBEST_PROJECT_ID); one that names another is not this session.
      // One that names none is refused, as over HTTP.
      const project = header(headers, PROJECT_HEADER)
      if (project._tag === "None")
        return yield* bad(`${method} claims session ${row.id} without ${PROJECT_HEADER} (VIBEST_PROJECT_ID)`)
      if (project.value !== String(row.projectId))
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
      return {
        _tag: "Session",
        sessionId: row.id,
        projectId: row.projectId,
        can: agents.of(row.agent).can,
      } satisfies CallerShape
    }
    return yield* bad(`${method} has caller ${kind.value}; expected cli or session`)
  })

/**
 * The integration version and protocol a session's request carries (`vibest-plugin-version`, `vibest-protocol`), recorded
 * on its row whether or not the protocol matches: `vibest update` restarts the agents whose integration is not its own.
 * Requests without a plugin version (the vibest CLI an agent runs) record nothing.
 */
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
    const agents = yield* Agents
    return CallerGate.of((effect, { headers, rpc }) =>
      resolveCaller(db, agents, headers, rpc._tag).pipe(
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
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const harnesses = yield* Harnesses

    const refused = (method: string, sessionId: string) =>
      new Forbidden({
        method,
        message: `session ${sessionId} may not call ${method}; its agent only reports to whoever started it (vibest report)`,
      })

    /** A coordinator's or the command line's request; a session's is refused. */
    const agent = (method: MethodOf<"agent">) =>
      Effect.gen(function* () {
        const c = yield* Caller
        if (c._tag === "Session") return yield* refused(method, c.sessionId)
        return c
      })

    /** A coordinator's, the command line's, or a session's whose agent may spawn. */
    const spawning = (method: MethodOf<"spawner">) =>
      Effect.gen(function* () {
        const c = yield* Caller
        if (c._tag === "Session" && !c.can.spawn) return yield* refused(method, c.sessionId)
        return c
      })

    /**
     * A request that may manage session `id`: the command line; its project's coordinator; a session whose agent may
     * message the project, or one that started `id` (directly or through its own sessions) and may message its children.
     */
    const managed = (method: MethodOf<"owner">, id: string) =>
      Effect.gen(function* () {
        const c = yield* Caller
        const session = yield* db.getSession(id)
        if (!session) return yield* new NoSuchSession({ id, message: `no session ${id}` })
        if (c._tag === "Cli") return
        const other = new Forbidden({
          method,
          message: `${id} is not yours to manage; only whoever started it, its project's main agent or the user may`,
        })
        if (session.projectId !== c.projectId) return yield* other
        if (c._tag === "Coordinator") return
        if (c.can.message === "project") return
        if (c.can.message === "children" && (yield* db.descends(id, c.sessionId))) return
        return yield* c.can.message === "report-only" ? refused(method, c.sessionId) : other
      })

    /** Root and key of a directory. A platform failure is a defect; not being a project is `NotInRepository`. */
    const atProject = (directory: string) =>
      projectRoot(directory).pipe(
        Effect.catchIf(
          (error) => error._tag !== "NotInRepository",
          (error) => Effect.die(error),
        ),
      )

    /** The project directory of the caller's working directory. Coordinator identity does not supply it. */
    const checkout = (c: Extract<CallerShape, { _tag: "Cli" | "Coordinator" }>, method: string) =>
      Effect.gen(function* () {
        const directory = c.repositoryRoot
        if (directory === undefined)
          return yield* new InvalidCaller({
            method,
            message: `${method} needs the repository of the working directory`,
          })
        return (yield* atProject(directory)).root
      })

    /** The request's project: the coordinator's own, or the cli directory (a multi-repository project or a main checkout). */
    const scope = (method: MethodOf<"agent">) =>
      Effect.gen(function* () {
        const c = yield* agent(method)
        if (c._tag === "Coordinator") {
          const key = yield* db.projectKey(c.projectId)
          if (key === undefined)
            return yield* new NotInRepository({ path: c.repositoryRoot ?? `project ${c.projectId}` })
          return { key }
        }
        return { key: (yield* atProject(c.repositoryRoot)).key }
      })

    /** The machine a caller names: `local` unless it says more (`RuntimeMachine`), opaque `target` included. */
    const machineOf = (machine: { readonly id: string; readonly target?: string | undefined } | undefined): Machine =>
      machine === undefined
        ? { id: "local" }
        : { id: machine.id, ...(machine.target !== undefined ? { target: machine.target } : {}) }
    /** One project's main-agent changes at a time: the running check and the launch (CoordinatorSession), and the stop. */
    const projectLocked = keyedLock<string>()

    /**
     * The project's main agent alive (idle or busy) in a terminal other than `terminal`, or null. Fails open: null when
     * the runtime cannot be reached or cannot tell.
     */
    const runningCoordinator = (key: Parameters<Db["Service"]["projectId"]>[0], terminal: string) =>
      Effect.gen(function* () {
        const coord = yield* db.coordinatorOf(yield* db.projectId(key))
        if (!coord?.address || coord.address.id === "" || !coord.runtime) return null
        if (coord.address.id === terminal) return null
        // A restart (`vibest update`) is between its harnesses there: running, though the runtime sees none right now.
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
    /** The one runtime loaded, when exactly one is: CoordinatorSession defaults to it. */
    const onlyRuntime = Effect.flatMap(runtimes.all, (all) => Effect.succeed(all.length === 1 ? all[0] : undefined))

    /**
     * Stop admitting changes, let the admitted ones and the daemon's own operations finish, then run `before` (a handoff
     * starts the new vibestd here) and accept once nothing is running and no claimed delivery is unsettled. Agents keep
     * running; pending Messages stay in sqlite for the next vibestd. A refused or cut-off stop, or a failing `before`,
     * opens again; an accepted one never does.
     */
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
          const idle = yield* blockers.pipe(
            Effect.repeat({ until: (pending) => pending.length === 0, schedule: Schedule.spaced("20 millis") }),
            Effect.timeoutOption(DRAIN_TIMEOUT),
          )
          if (Option.isNone(idle)) return yield* new DaemonBusy({ blockers: last })
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

    /** The user's command line only. */
    const cliOnly = (method: MethodOf<"cli">) =>
      Effect.flatMap(Caller, (c) =>
        c._tag === "Cli"
          ? Effect.void
          : Effect.fail(new Forbidden({ method, message: `only the user runs ${method}` })),
      )

    /**
     * Session `id` itself (`self`): its own harness's integration, or the user's command line at the root of the project
     * whose main agent `id` is (its start after a restart). The main agent's row, or undefined for its own integration.
     */
    const self = (method: MethodOf<"self">, id: string) =>
      Effect.gen(function* () {
        const c = yield* Caller
        if ((c._tag === "Session" || c._tag === "Coordinator") && c.sessionId === id) return undefined
        if (c._tag === "Cli") {
          const located = yield* atProject(c.repositoryRoot).pipe(Effect.option)
          const projectId = Option.isNone(located) ? undefined : yield* db.projectByKey(located.value.key)
          const main = projectId === undefined ? undefined : yield* db.coordinatorOf(projectId)
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
          const c = yield* spawning("Spawn")
          if (input.agent === "coordinator" || input.agent === "main")
            return yield* new Forbidden({
              method: "Spawn",
              message: `${input.agent} is reserved for the main agent (vibest)`,
            })
          // The main agent starts sessions in its own project wherever its shell is, e.g. inside one repository of a
          // multi-repository Project. Its working directory only counts for a main agent saved without its project directory.
          // A lead starts them from the directory it works in (its worktree is of the same project).
          const own =
            c._tag === "Coordinator"
              ? (yield* db.coordinatorOf(c.projectId))?.projectDirectory
              : c._tag === "Session"
                ? yield* db.directoryOf(c.sessionId)
                : undefined
          const directory = own ?? (c._tag === "Session" ? undefined : c.repositoryRoot)
          if (directory === undefined)
            return yield* new InvalidCaller({
              method: "Spawn",
              message: "vibest run needs a project: run it inside a git repository, or a directory of git repositories",
            })
          const project = yield* atProject(directory)
          if (c._tag !== "Cli" && (yield* db.projectId(project.key)) !== c.projectId)
            return yield* new Forbidden({
              method: "Spawn",
              message:
                "a main agent only starts sessions in its own project: cd into the directory where vibest was started and run it again",
            })
          return yield* sessions.spawn({
            machine: machineOf(input.machine),
            root: project.root,
            key: project.key,
            name: input.name ?? nameFrom(input.prompt),
            prompt: input.prompt,
            harness: input.harness,
            provider: input.provider,
            model: input.model,
            env: input.env,
            agent: input.agent,
            peer: input.peer,
            archive: input.archive,
            parentSessionId: c._tag === "Cli" ? undefined : c.sessionId,
          })
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
          const c = yield* agent("Launch")
          const root = yield* checkout(c, "Launch")
          const { key } = yield* scope("Launch")
          const at = machineOf(machine)
          // The runtime is chosen as a start chooses one (§4): the choice chain — the caller's `vibest --runtime` stands,
          // else the running coordinator's, else the configured one — never a silent pick. The harness that same chain
          // routes is this command's own to choose, in the pane it opens.
          const current = yield* db.coordinatorOf(yield* db.projectId(key))
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
            machines: yield* machinesListing(
              runtimes,
              harnesses.all().map((a) => a.id),
            ).pipe(Effect.orElseSucceed(() => [])),
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
            argv,
            label: "vibest",
            home: layout.home,
            focus,
          })
          return {
            runtime: rt.kind,
            terminal: terminal.id,
            place: placeOf(rt.kind, terminal),
            attach: rt.attach?.(at) ?? null,
          }
        }),

      Send: ({ id, message }) => managed("Send", id).pipe(Effect.andThen(sessions.send(id, message))),
      Interrupt: ({ id }) => managed("Interrupt", id).pipe(Effect.andThen(sessions.interrupt(id))),
      Remove: ({ id, keepWorktree }) =>
        managed("Remove", id).pipe(
          Effect.andThen(sessions.remove(id, { keepWorktree })),
          // Unreachable is the protocol's own error; any other runtime refusal is a server bug.
          Effect.catchTag("RuntimeError", (e) =>
            e.code === "unreachable"
              ? Effect.fail(new RuntimeUnreachable({ session: id, message: e.message }))
              : Effect.die(e),
          ),
          Effect.map((out) => out ?? null),
        ),

      List: ({ stopped, all }) =>
        Effect.gen(function* () {
          const c = yield* spawning("List")
          // A cli in a project sees that project, including its main agent. `all`: every project (`stop` in none). Not a
          // Project and not `all`: no sessions of this directory to show.
          const projectId =
            c._tag !== "Cli"
              ? c.projectId
              : all === true
                ? undefined
                : yield* atProject(c.repositoryRoot ?? "").pipe(
                    Effect.flatMap((located) => db.projectByKey(located.key)),
                    Effect.catchTag("NotInRepository", () => Effect.succeed(undefined)),
                  )
          if (projectId === undefined && all !== true) return []
          const rows = yield* sessions.list({
            ...(projectId === undefined ? {} : { projectId }),
            stopped: stopped === true,
          })
          const briefs = yield* db.sessionBriefs(rows.map((row) => row.id))
          // The main agents first, with how they were routed; one with no place is not running.
          const mains = projectId === undefined ? yield* db.coordinators : [yield* db.coordinatorOf(projectId)]
          return [
            ...(yield* Effect.forEach(mains, (m) =>
              Effect.gen(function* () {
                if (!m?.runtime || !m.address || m.address.id === "") return undefined
                const h = yield* runtimes.route(m.runtime).pipe(Effect.option)
                const status = Option.isNone(h) ? "unknown" : yield* mainStatus(h.value, m.address)
                return mainInfo(m, status)
              }),
            )).flatMap((m) => (m ? [m] : [])),
            ...rows.map((row) => {
              const brief = briefs.get(row.id)
              return { ...toInfo(row, brief), task: taskForLs(brief?.task ?? null) }
            }),
          ]
        }),

      Get: ({ id }) =>
        Effect.gen(function* () {
          yield* spawning("Get")
          const row = yield* sessions.get(id)
          const session = toInfo(row, (yield* db.sessionBriefs([id])).get(id))
          return { ...session, result: (yield* db.latestInbox(id, "result")) ?? null }
        }),

      Peek: ({ id, lines }) =>
        managed("Peek", id).pipe(
          Effect.andThen(sessions.peek(id, lines ?? 30)),
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

      "Project.StartMain": ({ harness, provider, model, runtime }) =>
        Effect.gen(function* () {
          const caller = yield* agent("Project.StartMain")
          // Scheduling sees the project directory. The key is only how the row is stored.
          const root = yield* checkout(caller, "Project.StartMain")
          const { key } = yield* scope("Project.StartMain")
          const current = yield* db.coordinatorOf(yield* db.projectId(key))
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
            parentRuntime: current?.runtime ?? undefined,
            machines: yield* machinesListing(
              runtimes,
              harnesses.all().map((a) => a.id),
            ).pipe(Effect.orElseSucceed(() => [])),
          })
          if (decision.harness === undefined) return yield* new NoHarnessChosen()
          if (harnesses.find(decision.harness) === undefined)
            return yield* new HarnessUnavailable({
              harness: decision.harness,
              message: `unknown harness ${decision.harness} (routed: ${describeSpawn({ ...decision, harness: decision.harness })})`,
            })
          // The runtime choice is checked like the harness's (§4): online on the machine, else the start refuses.
          if (decision.runtime === undefined)
            return yield* new NoRuntime({ message: "no terminal runtime was chosen for the main agent" })
          const rt = yield* runtimes.route(decision.runtime)
          yield* runtimes.online(rt, { id: decision.machine.id })
          return { ...decision, harness: decision.harness, runtime: rt.kind }
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
          const caller = yield* agent("Project.CoordinatorSession")
          const projectDirectory =
            caller.repositoryRoot === undefined
              ? undefined
              : Option.getOrUndefined(yield* atProject(caller.repositoryRoot).pipe(Effect.option))
          const { key } = yield* scope("Project.CoordinatorSession")
          const kind = runtime ?? (yield* onlyRuntime)?.kind
          if (kind === undefined)
            return yield* new InvalidCaller({
              method: "Project.CoordinatorSession",
              message: "Project.CoordinatorSession needs the runtime the main agent runs in",
            })
          // One main agent per project: every start goes through here, so a second one is refused here. The check and the
          // launch hold the project's lock, as a stop does, so two starts at once cannot both pass.
          return yield* projectLocked.withLock(key)(
            Effect.gen(function* () {
              const running = yield* runningCoordinator(key, terminal)
              if (running)
                return yield* new Forbidden({
                  method: "Project.CoordinatorSession",
                  message: `the main agent (${running.harness}) is still running in ${running.place}, and a project has one main agent; exit it there first, or run vibest here on an interactive terminal and answer y to move it here`,
                })
              const saved = yield* db.coordinatorLaunch(
                key,
                harness,
                fresh,
                { runtime: kind, address: { machine: machineOf(machine).id, id: terminal } },
                {
                  provider,
                  model,
                  routing,
                  pid,
                  ...(projectDirectory ? { projectDirectory: projectDirectory.root } : {}),
                },
              )
              const projectId = yield* db.projectId(key)
              if (env && Object.keys(env).length > 0) mainEnv.set(projectId, { sessionId: saved.sessionId, env })
              else mainEnv.delete(projectId)
              return { ...saved, runtime: runtimeEnv(kind, { machine: machineOf(machine).id, id: terminal }) }
            }),
          )
        }),

      "Project.RunningCoordinator": ({ terminal }) =>
        scope("Project.RunningCoordinator").pipe(Effect.flatMap(({ key }) => runningCoordinator(key, terminal))),

      "Project.StopCoordinator": ({ runtime, address }) =>
        Effect.gen(function* () {
          const { key } = yield* scope("Project.StopCoordinator")
          return yield* projectLocked.withLock(key)(
            Effect.gen(function* () {
              const projectId = yield* db.projectId(key)
              const coord = yield* db.coordinatorOf(projectId)
              const place = coord?.address
              if (!coord?.runtime || !place || place.id === "" || !sameCoordinator(coord, runtime, address))
                return { result: "moved" as const }
              // ponytail: refused, not waited for; the restart's next harness starts there in seconds.
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
              })
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

      "Agents.Outdated": () => cliOnly("Agents.Outdated").pipe(Effect.andThen(sessions.outdated)),

      "Agents.Restart": ({ ids, after }) =>
        cliOnly("Agents.Restart").pipe(Effect.andThen(sessions.restartLater(ids, after))),

      "Project.Info": () => scope("Project.Info").pipe(Effect.flatMap(project.info)),
      "Project.List": (input) => scope("Project.List").pipe(Effect.flatMap((s) => project.list(s, input))),
      "Project.Read": (input) => scope("Project.Read").pipe(Effect.flatMap((s) => project.read(s, input))),
      "Project.Search": (input) => scope("Project.Search").pipe(Effect.flatMap((s) => project.search(s, input))),
      "Project.Write": (input) => scope("Project.Write").pipe(Effect.flatMap((s) => project.write(s, input))),
      "Project.Delete": (input) => scope("Project.Delete").pipe(Effect.flatMap((s) => project.delete(s, input))),

      // Stop admitting changes, let the admitted ones and the daemon's own operations finish, and accept once nothing is
      // running and no claimed delivery is unsettled. Agents keep running; pending Messages stay in sqlite for the next
      // vibestd. A refused or cut-off Stop opens again; an accepted one never does.
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

      // A handoff (vibest update): Stop's drain, with the new vibestd started in between, waiting for this one's lock.
      "Daemon.Handoff": ({ instance, command }) =>
        Effect.gen(function* () {
          yield* cliOnly("Daemon.Handoff")
          if (instance !== identity.instance)
            return yield* new WrongInstance({ expected: instance, actual: identity.instance ?? null })
          const quoted = command.map(shellQuote).join(" ")
          // The new vibest must be able to open this database before anything stops; it only reads it.
          const checked = yield* spawner
            .spawn(ChildProcess.make(command[0]!, [...command.slice(1), "daemon", "import-check"], { stdin: "ignore" }))
            .pipe(
              Effect.flatMap((handle) =>
                Effect.all(
                  [Stream.mkString(Stream.decodeText(handle.stderr)), handle.exitCode, Stream.runDrain(handle.stdout)],
                  { concurrency: "unbounded" },
                ),
              ),
              Effect.map(([output, code]) => (code === 0 ? undefined : output.trim() || `exit ${code}`)),
              Effect.scoped,
              Effect.timeoutOrElse({ duration: "15 seconds", orElse: () => Effect.succeed("no answer in 15s") }),
              Effect.catch((e) => Effect.succeed(e.message)),
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

/** The RPC server on whatever SocketServer is provided. */
export const layer = RpcServer.layer(VibestRpcs).pipe(
  Layer.provide(Layer.mergeAll(handlers, AdmissionLive)),
  Layer.provide(CallerGateLive),
  Layer.provide(ProtocolGateLive),
  Layer.provide(RpcServer.layerProtocolSocketServer),
  Layer.provide(RpcSerialization.layerNdJsonRpc()),
)
