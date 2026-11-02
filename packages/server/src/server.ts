import { type CoordinatorRow, Db, encodeAddress, type RuntimeAddress, type SessionBrief } from "@vibest/core/db"
import { Drain } from "@vibest/core/drain"
import { harnessOptions, Harnesses, HarnessUnavailable, isHarnessId } from "@vibest/core/harness"
import { coordinatorIdle, Inbox } from "@vibest/core/inbox"
import * as Launch from "@vibest/core/launch"
import { Layout } from "@vibest/core/paths"
import { describeSpawn, Plugins } from "@vibest/core/plugins"
import { Project } from "@vibest/core/project"
import { projectRoot } from "@vibest/core/project-create"
import { stopAgent } from "@vibest/core/remove"
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
import { STOP_WAIT } from "@vibest/core/sessions"
import { NoSuchSession, type SessionView, Sessions } from "@vibest/core/sessions"
import { Subscriptions } from "@vibest/core/subscriptions/service"
import { NotInRepository } from "@vibest/core/worktree"
import { CALLER_HEADER, PROTOCOL, PROTOCOL_HEADER, REPOSITORY_HEADER, SESSION_HEADER } from "@vibest/protocol/protocol"
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
import { HARNESS_IDS, NoHarnessChosen, type AgentStatus } from "@vibest/schema/session"
import { RuntimeUnreachable } from "@vibest/schema/session"
// vibestd's side of the RPC contract (SPEC §7): handlers over Sessions / Inbox / Project, served on a SocketServer
// (the unix socket comes from #platform). Caller and protocol are request headers, checked by middleware before the
// handler effect runs. Middleware must not call client.annotate: a later request on the same socket starts clean.
import { Context, Deferred, Duration, Effect, Layer, Option, Schedule, Stream } from "effect"
import * as Headers from "effect/http/Headers"
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
 * `agent`: a coordinator's or the command line's. `coordinator`: a coordinator only. `owner`: a coordinator of the
 * session's project, or the command line. The table must list every method.
 */
const ACCESS = {
  Ping: "open",
  Plugins: "open",
  "Runtimes.Doctor": "open",
  Subscriptions: "open",
  Republish: "open",
  ResultReady: "open",
  Prompt: "open",
  CoordinatorSessionReady: "open",
  Report: "session",
  Spawn: "agent",
  Launch: "agent",
  List: "agent",
  Get: "agent",
  "Inbox.Subscribe": "coordinator",
  "Inbox.Attach": "coordinator",
  "Inbox.Pull": "coordinator",
  "Inbox.Ack": "coordinator",
  "Inbox.Release": "coordinator",
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
} as const satisfies Record<
  RpcGroup.Rpcs<typeof VibestRpcs>["_tag"],
  "open" | "session" | "agent" | "coordinator" | "owner" | "cli"
>
type Access = typeof ACCESS
type MethodOf<A> = { [K in keyof Access]: Access[K] extends A ? K : never }[keyof Access]

/** Default session name: the prompt's first line, shortened. */
const nameFrom = (prompt: string) => (prompt.trim().split("\n")[0] ?? "").slice(0, 40) || "task"

/** This vibestd's identity for Ping, set by Daemon.run; empty on a server a test runs without one. */
export const Identity = Context.Reference<DaemonIdentity>("vibest/DaemonIdentity", { defaultValue: () => ({}) })

/** Completed when a Daemon.Stop is accepted; Daemon.run waits for it, then closes the server, the lock last. */
export const Shutdown = Context.Reference<Deferred.Deferred<void>>("vibest/DaemonShutdown", {
  defaultValue: () => Deferred.makeUnsafe<void>(),
})

/** A bounded wait for daemon operations to drain, never for agents to finish their tasks. */
export const DRAIN_TIMEOUT = Duration.seconds(5)

/** Changes are counted until they end, failed or interrupted ones too; refused while a Stop drains, except Inbox.Ack/Release settling a delivery already made. Only at the RPC entry. */
export const AdmissionLive = Layer.effect(
  Admission,
  Effect.gen(function* () {
    const drain = yield* Drain
    return Admission.of((effect, { rpc }) =>
      Effect.acquireUseRelease(
        drain.admit(rpc._tag, rpc._tag === "Inbox.Ack" || rpc._tag === "Inbox.Release"),
        (leave) => (leave ? effect : Effect.fail(new DaemonStopping({ method: rpc._tag }))),
        (leave) => leave ?? Effect.void,
      ),
    )
  }),
)

const header = (headers: Headers.Headers, name: string) => Headers.get(headers, name)

/** Missing, mixed, or malformed caller headers. Never becomes cli. */
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

export const ProtocolGateLive = Layer.succeed(
  ProtocolGate,
  ProtocolGate.of((effect, { headers, rpc }) => {
    const protocol = header(headers, PROTOCOL_HEADER)
    if (protocol._tag === "None" || protocol.value !== String(PROTOCOL)) {
      return Effect.fail(
        new ProtocolRejected({ method: rpc._tag, protocol: protocol._tag === "None" ? null : protocol.value }),
      )
    }
    return effect
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
    const runtimes = yield* Runtimes
    const project = yield* Project
    const layout = yield* Layout
    const plugins = yield* Plugins
    const subscriptions = yield* Subscriptions
    const identity = yield* Identity
    const shutdown = yield* Shutdown
    const drain = yield* Drain

    /** A coordinator's or the command line's request; a session's is refused. */
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

    /** A request that may manage session `id`: its project's coordinator, or the command line. */
    const managed = (method: MethodOf<"owner">, id: string) =>
      Effect.gen(function* () {
        const c = yield* agent(method)
        const session = yield* db.getSession(id)
        if (!session) return yield* new NoSuchSession({ id, message: `no session ${id}` })
        if (c._tag === "Coordinator" && session.projectId !== c.projectId)
          return yield* new Forbidden({
            method,
            message: `${id} belongs to another coordinator; only it or the user may manage it`,
          })
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
    /** The one runtime loaded, when exactly one is: CoordinatorSession defaults to it. */
    const onlyRuntime = Effect.flatMap(runtimes.all, (all) => Effect.succeed(all.length === 1 ? all[0] : undefined))

    const coordinator = (method: MethodOf<"coordinator">) =>
      Effect.gen(function* () {
        const c = yield* Caller
        if (c._tag !== "Coordinator") return yield* new Forbidden({ method, message: `${method} is the coordinator's` })
        return c
      })

    const inboxCall = (method: MethodOf<"coordinator">, terminal: string, claudeSessionId: string) =>
      Effect.gen(function* () {
        const c = yield* coordinator(method)
        return { projectId: c.projectId, terminal, claudeSessionId }
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
          Effect.map((rows) => ({ protocol: PROTOCOL, version: VERSION, runtimes: rows, ...identity })),
        ),

      Spawn: (input) =>
        Effect.gen(function* () {
          const c = yield* agent("Spawn")
          if (input.agent === "coordinator" || input.agent === "main")
            return yield* new Forbidden({
              method: "Spawn",
              message: `${input.agent} is reserved for the main agent (vibest)`,
            })
          // The main agent starts sessions in its own project wherever its shell is, e.g. inside one repository of a
          // multi-repository Project. Its working directory only counts for a main agent saved without its project directory.
          const own = c._tag === "Coordinator" ? (yield* db.coordinatorOf(c.projectId))?.projectDirectory : undefined
          const directory = own ?? c.repositoryRoot
          if (directory === undefined)
            return yield* new InvalidCaller({
              method: "Spawn",
              message: "vibest run needs a project: run it inside a git repository, or a directory of git repositories",
            })
          const project = yield* atProject(directory)
          if (c._tag === "Coordinator" && (yield* db.projectId(project.key)) !== c.projectId)
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
            parentSessionId: c._tag === "Coordinator" ? c.sessionId : undefined,
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
          const c = yield* agent("List")
          // A cli in a project sees that project, including its main agent. `all`: every project (`stop` in none). Not a
          // Project and not `all`: no sessions of this directory to show.
          const projectId =
            c._tag === "Coordinator"
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
          yield* agent("Get")
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

      "Inbox.Attach": ({ claudeSessionId, replace, terminal }) =>
        Effect.gen(function* () {
          const call = yield* inboxCall("Inbox.Attach", terminal, claudeSessionId)
          return yield* inbox.attach({ ...call, replace })
        }),
      "Inbox.Pull": ({ generation, claudeSessionId, terminal }) =>
        Effect.gen(function* () {
          const call = yield* inboxCall("Inbox.Pull", terminal, claudeSessionId)
          return yield* inbox.pull({ ...call, generation })
        }),
      "Inbox.Ack": ({ generation, claudeSessionId, token, terminal }) =>
        Effect.gen(function* () {
          const call = yield* inboxCall("Inbox.Ack", terminal, claudeSessionId)
          return yield* inbox.ack({ ...call, generation, token })
        }),
      "Inbox.Release": ({ generation, claudeSessionId, token, retry, terminal }) =>
        Effect.gen(function* () {
          const call = yield* inboxCall("Inbox.Release", terminal, claudeSessionId)
          return yield* inbox.release({ ...call, generation, token, retry })
        }),

      ResultReady: ({ sessionId }) => sessions.resultReady(sessionId),

      Prompt: ({ sessionId, text }) => sessions.userPrompt(sessionId, text),

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
            machines: yield* machinesListing(runtimes, [...HARNESS_IDS]).pipe(Effect.orElseSucceed(() => [])),
          })
          if (decision.harness === undefined) return yield* new NoHarnessChosen()
          if (!isHarnessId(decision.harness))
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

      "Project.CoordinatorSession": ({ harness, fresh, terminal, machine, runtime, provider, model, routing }) =>
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
          const saved = yield* db.coordinatorLaunch(
            key,
            harness,
            fresh,
            { runtime: kind, address: { machine: machineOf(machine).id, id: terminal } },
            {
              provider,
              model,
              routing,
              ...(projectDirectory ? { projectDirectory: projectDirectory.root } : {}),
            },
          )
          yield* inbox.reconcile(yield* db.projectId(key))
          return saved
        }),

      "Project.RunningCoordinator": ({ terminal }) =>
        Effect.gen(function* () {
          const { key } = yield* scope("Project.RunningCoordinator")
          const coord = yield* db.coordinatorOf(yield* db.projectId(key))
          if (!coord?.address || coord.address.id === "" || !coord.runtime) return null
          if (coord.address.id === terminal) return null
          const h = yield* runtimes.route(coord.runtime).pipe(Effect.option)
          if (Option.isNone(h)) return null
          const presence = yield* coordinatorIdle(h.value, coord.address).pipe(Effect.option)
          if (Option.isNone(presence) || (presence.value !== "idle" && presence.value !== "busy")) return null
          return {
            harness: coord.harnessId,
            place: placeOf(coord.runtime, coord.address),
            runtime: coord.runtime,
            address: encodeAddress(coord.address),
          }
        }),

      "Project.StopCoordinator": ({ runtime, address }) =>
        Effect.gen(function* () {
          const { key } = yield* scope("Project.StopCoordinator")
          const projectId = yield* db.projectId(key)
          const coord = yield* db.coordinatorOf(projectId)
          const place = coord?.address
          if (!coord?.runtime || !place || place.id === "" || !sameCoordinator(coord, runtime, address))
            return { result: "moved" as const }
          const h = yield* runtimes
            .route(runtime)
            .pipe(Effect.mapError((e) => new InvalidCaller({ method: "Project.StopCoordinator", message: e.message })))
          const result = yield* stopAgent(h, place, {
            interruptKey: (yield* Harnesses).get(coord.harnessId).interruptKey,
            stillThere: db
              .coordinatorOf(projectId)
              .pipe(Effect.map((current) => sameCoordinator(current, runtime, address))),
            wait: STOP_WAIT,
          })
          return { result }
        }),

      CoordinatorSessionReady: ({ sessionId, harness, harnessSessionId }) =>
        db.reportCoordinatorSession(sessionId, harness, harnessSessionId).pipe(
          Effect.andThen(db.projectOfSession(sessionId)),
          Effect.flatMap((projectId) => (projectId === undefined ? Effect.void : inbox.reconcile(projectId))),
        ),
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
          if (!(yield* drain.begin)) return yield* new DaemonStopping({ method: "Daemon.Stop" })
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
