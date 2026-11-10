import { importCheck, spawnDaemon } from "@vibest/client/client"
import { raisesSeen } from "@vibest/core/activity"
import { Bus, type EngineEvent } from "@vibest/core/bus"
import { callerTarget, filterCallerEnv, mainPlace, specHits } from "@vibest/core/caller"
import { Db } from "@vibest/core/db"
import { Drain } from "@vibest/core/drain"
import { LayerNode } from "@vibest/core/effect/layer-node"
import * as PlatformNode from "@vibest/core/effect/platform"
import { Harness, Harnesses } from "@vibest/core/harness"
import type { HarnessDefinition } from "@vibest/core/host"
import { VibestdIdentity } from "@vibest/core/identity"
import { Inbox } from "@vibest/core/inbox"
import { keyedLock } from "@vibest/core/keyed-lock"
import { Machines } from "@vibest/core/machines"
import { MainAgent } from "@vibest/core/main-agent"
import { shellQuote } from "@vibest/core/paths"
import { Peers } from "@vibest/core/peer"
import { Plugins } from "@vibest/core/plugins"
import { Processes } from "@vibest/core/processes"
import { Project } from "@vibest/core/project"
import { createProject } from "@vibest/core/project-create"
import { locateProject, resolveProject } from "@vibest/core/project-identity"
import { Remote } from "@vibest/core/remote"
import { SshHosts } from "@vibest/core/repository-url"
import { envelope } from "@vibest/core/results"
import { machinesListing, Runtimes } from "@vibest/core/runtimes"
import { defaultSessionName, NoSuchSession, Sessions } from "@vibest/core/sessions"
import { Subscriptions } from "@vibest/core/subscriptions/service"
import * as UpdateCheckNode from "@vibest/core/update-check"
import { UpdateCheck } from "@vibest/core/update-check"
import { Git, NotInRepository } from "@vibest/core/worktree"
import { PROTOCOL } from "@vibest/protocol/protocol"
import {
  type ACCESS,
  Caller,
  CAPABILITIES,
  type DaemonIdentity,
  Forbidden,
  InvalidCaller,
  VibestRpcs,
  WatchLagged,
  type WatchEvent,
  VERSION,
  WrongInstance,
  type CallerShape,
} from "@vibest/protocol/rpc"
import { LaunchFailed } from "@vibest/schema/session"
import { RuntimeUnreachable } from "@vibest/schema/session"
import { Clock, Context, Deferred, Effect, Layer, Queue, Stream } from "effect"
import * as Headers from "effect/http/Headers"
import { ChildProcessSpawner } from "effect/process"
import { RpcSerialization, RpcServer } from "effect/rpc"
import * as SocketServer from "effect/socket/SocketServer"

import { AdmissionLive, CallerGateLive, noteOpen, ProtocolGateLive, reader } from "./gates.ts"
import * as Hooks from "./hooks.ts"
import { integrationHandlers } from "./integration.ts"
import { sessionListing, toInfo } from "./listing.ts"
import { remoteHandlers } from "./remote-handlers.ts"
import { services } from "./services.ts"
import { stopOnce as stopDaemon } from "./stop.ts"

type Access = typeof ACCESS
type MethodOf<A> = { [K in keyof Access]: Access[K] extends A | readonly [A, "peer"] ? K : never }[keyof Access]

export class Identity extends Context.Service<Identity, DaemonIdentity>()("vibest/DaemonIdentity") {
  static readonly node = LayerNode.unbound(Identity)
}

export class Shutdown extends Context.Service<Shutdown, Deferred.Deferred<void>>()("vibest/DaemonShutdown") {
  static readonly node = LayerNode.unbound(Shutdown)
}

export const HANDOFF_ENV = "VIBEST_HANDOFF_ENV"

export { DRAIN_TIMEOUT } from "./stop.ts"
export { PRESENT_TIMEOUT } from "@vibest/core/main-agent"

export const WATCH_BACKLOG = 10_000

export const handlers = VibestRpcs.toLayer(
  Effect.gen(function* () {
    const sessions = yield* Sessions
    const inbox = yield* Inbox
    const db = yield* Db
    const runtimes = yield* Runtimes
    const project = yield* Project
    const plugins = yield* Plugins
    const subscriptions = yield* Subscriptions
    const identity = yield* Identity
    const updateStatus = yield* UpdateCheck
    const shutdown = yield* Shutdown
    const drain = yield* Drain
    const bus = yield* Bus
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const harnesses = yield* Harnesses
    const mainAgent = yield* MainAgent

    const hook = <E>(
      sessionId: string,
      harness: string,
      headers: Headers.Headers,
      run: (who: Hooks.HookCaller, definition: HarnessDefinition) => Effect.Effect<void, E>,
    ) =>
      Effect.gen(function* () {
        yield* noteOpen(db, reader(headers), sessionId)
        const row = yield* db.sessionIdentity(sessionId)
        const definition = harnesses.find(harness)
        if (!row || row.harness !== harness || definition === undefined) return
        yield* run(row, definition)
      }).pipe(Effect.orDie)

    const agent = (method: MethodOf<"agent" | "owner">) =>
      Effect.gen(function* () {
        const c = yield* Caller
        if (c._tag === "Cli" || c._tag === "Coordinator") return c
        return yield* new Forbidden({
          method,
          message: `only the user or a main agent calls ${method}; sessions only report to their coordinator (vibest report)`,
        })
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

    const machineFromCaller = (input: {
      readonly callerEnv: Readonly<Record<string, string>>
      readonly runtimeSession?: string | undefined
    }) =>
      Effect.gen(function* () {
        const specs = yield* plugins.settled.pipe(Effect.andThen(runtimes.callers))
        const target = callerTarget(specs, filterCallerEnv(specs, input.callerEnv), input.runtimeSession)
        return { id: "local", ...(target !== undefined ? { target } : {}) }
      })
    const seenLocked = keyedLock<string>()

    const { listed, watched, snapshotProjects, watchDeltas } = sessionListing({ db, sessions, runtimes })

    const integration = yield* integrationHandlers
    const stopOnce = stopDaemon({ drain, bus, sendingInbox: db.sendingInbox, shutdown })

    const cliOnly = (method: MethodOf<"cli">) =>
      Effect.flatMap(Caller, (c) =>
        c._tag === "Cli"
          ? Effect.succeed(c)
          : Effect.fail(new Forbidden({ method, message: `only the user runs ${method}` })),
      )

    const self = (method: MethodOf<"self">, id: string) =>
      Effect.gen(function* () {
        const c = yield* Caller
        if ((c._tag === "Session" || c._tag === "Coordinator") && c.sessionId === id) return undefined
        return yield* new Forbidden({ method, message: `${method} ${id} runs only in that agent's own terminal` })
      })

    const { reach, routed, spawnOn, methods } = yield* remoteHandlers({ agent, projectOf, findAt, listed, cliOnly })

    const managed = (method: MethodOf<"owner">, input: string) =>
      Effect.gen(function* () {
        const { c, scope } = yield* reach(method)
        const id = yield* db.resolveSession(input, scope)
        if (c === undefined) return id
        const session = yield* db.getSession(id)
        if (!session) {
          const identity = yield* db.sessionIdentity(id)
          if (identity?.agent === "coordinator") {
            const directory = yield* db.projectDirectory(identity.projectId)
            const name =
              directory !== undefined && directory !== ""
                ? directory.slice(directory.lastIndexOf("/") + 1)
                : identity.projectId
            return yield* new NoSuchSession({
              id,
              message: `${id} is the main agent of project ${name}. Stop it in its terminal.`,
            })
          }
          return yield* new NoSuchSession({ id, message: `no session ${id}` })
        }
        if (c._tag === "Coordinator" && session.projectId !== c.projectId)
          return yield* new Forbidden({
            method,
            message: `${id} belongs to another coordinator; only it or the user may manage it`,
          })
        return id
      })

    return VibestRpcs.of({
      ...methods,
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
          Effect.zip(updateStatus),
          Effect.map(([rows, update]) => ({
            protocol: PROTOCOL,
            version: VERSION,
            runtimes: rows,
            update,
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
          if (input.machine !== undefined) return yield* spawnOn(input.machine, input, c, project.id)
          return yield* sessions.spawn({
            machine: yield* machineFromCaller(input),
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
            runtime: input.runtime,
            parentSessionId: c._tag === "Coordinator" ? c.sessionId : undefined,
            request: input.request,
          })
        }),

      Plugins: () => plugins.list,

      ...integration,

      "Runtimes.Doctor": ({ harnesses }) =>
        Effect.flatMap(runtimes.statuses({ id: "local" }), (rows) =>
          Effect.forEach(rows, ({ runtime, status }) =>
            (runtime.doctor
              ? runtime.doctor({ id: "local" }, harnesses)
              : Effect.succeed({ name: runtime.id, checks: [] })
            ).pipe(
              Effect.map((report) => ({
                kind: runtime.id,
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

      Launch: ({ argv, focus, runtime, callerEnv, runtimeSession }) =>
        Effect.gen(function* () {
          const { id, directory } = yield* scope("Launch")
          const at = yield* machineFromCaller({ callerEnv, runtimeSession })
          return yield* mainAgent.launch({ projectId: id, root: directory, at, argv, focus, runtime })
        }).pipe(
          Effect.catchTag("MainAgentRunning", (e) =>
            Effect.fail(
              new Forbidden({
                method: "Launch",
                message: `the main agent (${e.harness}) is still running in ${e.place}, and a project has one main agent; exit it there first`,
              }),
            ),
          ),
        ),

      Send: (p) =>
        routed.Send(p, (id) =>
          managed("Send", id).pipe(
            Effect.flatMap((id) => sessions.send(id, p.message, p.request).pipe(Effect.as({ id }))),
          ),
        ),
      Interrupt: (p) =>
        routed.Interrupt(p, (id) =>
          managed("Interrupt", id).pipe(
            Effect.flatMap((id) => sessions.interrupt(id).pipe(Effect.map((out) => ({ id, ...out })))),
          ),
        ),
      Remove: (p) =>
        routed.Remove(p, (id) =>
          managed("Remove", id).pipe(
            Effect.flatMap((id) =>
              sessions
                .remove(id, { keepWorktree: p.keepWorktree })
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
        ),

      Get: (p) =>
        routed.Get(p, (input) =>
          Effect.gen(function* () {
            const id = yield* db.resolveSession(input, (yield* reach("Get")).scope)
            const row = yield* sessions.get(id)
            const session = toInfo(row, (yield* db.sessionBriefs([id])).get(id))
            return { ...session, result: (yield* db.latestInbox(id, "result")) ?? null }
          }),
        ),

      Peek: (p) =>
        routed.Peek(p, (id) =>
          managed("Peek", id).pipe(
            Effect.flatMap((id) => sessions.peek(id, p.lines ?? 30)),
            Effect.map((text) => ({ text })),
          ),
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
            const sessionRows = yield* watched(yield* listed({ _tag: "All" }, false))
            const snapshot: WatchEvent = {
              _tag: "Snapshot",
              projects: yield* snapshotProjects(sessionRows),
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

      "Session.Seen": ({ id, turn }) =>
        Effect.gen(function* () {
          yield* cliOnly("Session.Seen")
          const identity = yield* db.sessionIdentity(id)
          if (identity === undefined) return yield* new NoSuchSession({ id, message: `no session ${id}` })
          const at =
            identity.agent === "coordinator" ? yield* db.coordinatorOf(identity.projectId) : yield* db.getSession(id)
          if (at?.id !== id || !at.runtime || !at.address || at.address.id === "") return
          const address = at.address
          const rt = runtimes.find(at.runtime)
          if (rt === undefined || rt.seen === undefined || rt.see === undefined) return
          const see = rt.see
          const unreachable = (e: { readonly message: string }) =>
            new RuntimeUnreachable({ session: id, message: e.message })
          const seen = rt.seen
          yield* Effect.gen(function* () {
            const now = yield* seen(address).pipe(Effect.mapError(unreachable))
            if (raisesSeen(now, turn)) yield* see(address, turn).pipe(Effect.mapError(unreachable))
          }).pipe(seenLocked.withLock(`${at.runtime}\n${address.machine}\n${address.id}`))
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

      TurnEnd: ({ sessionId, harness, event }, { headers }) =>
        hook(sessionId, harness, headers, (who, definition) => Hooks.turnEnd(db, definition, who, event)),

      Prompt: ({ sessionId, harness, event }, { headers }) =>
        hook(sessionId, harness, headers, (who, definition) => Hooks.prompt(sessions, db, definition, who, event)),

      "Project.StartMain": ({ harness, provider, model, runtime }) =>
        Effect.gen(function* () {
          const { id, directory } = yield* scope("Project.StartMain")
          return yield* mainAgent.start({ projectId: id, root: directory, harness, provider, model, runtime })
        }),

      "Project.Open": ({ move }) =>
        Effect.gen(function* () {
          const c = yield* cliOnly("Project.Open")
          const project = yield* resolveProject(db, yield* atProject(c.repositoryRoot), move)
          return {
            projectId: project.id,
            directory: project.directory,
            ...("moved" in project ? { moved: project.moved } : {}),
            ...("candidates" in project ? { candidates: project.candidates } : {}),
          }
        }),

      "Project.MainPlace": ({ callerEnv, runtime }) =>
        Effect.gen(function* () {
          const c = yield* cliOnly("Project.MainPlace")
          const project = yield* resolveAt(c.repositoryRoot)
          const specs = yield* plugins.settled.pipe(Effect.andThen(runtimes.callers))
          const env = filterCallerEnv(specs, callerEnv)
          const hits = yield* specHits(specs, env, runtime).pipe(Effect.orDie)
          const place = mainPlace({ runtime, hits })
          if (place.in === "refused") return yield* new LaunchFailed({ message: place.message })
          if (place.in === "terminal") {
            const spec = specs.find((item) => item.id === place.runtime)
            if (spec?.ready !== undefined && !(yield* spec.ready(env).pipe(Effect.orDie)))
              return yield* new LaunchFailed({
                message: spec.missing ?? `this ${spec.name ?? place.runtime} place could not be named`,
              })
          }
          return { directory: project.directory, place }
        }),

      "Project.CoordinatorSession": ({ harness, fresh, terminal, runtime, provider, model, routing, pid }) =>
        Effect.gen(function* () {
          const { id, directory } = yield* scope("Project.CoordinatorSession")
          return yield* mainAgent.claim({
            projectId: id,
            directory,
            harness,
            fresh,
            terminal,
            runtime,
            provider,
            model,
            routing,
            pid,
          })
        }).pipe(
          Effect.catchTags({
            NoRuntime: () =>
              Effect.fail(
                new InvalidCaller({
                  method: "Project.CoordinatorSession",
                  message: "Project.CoordinatorSession needs the runtime the main agent runs in",
                }),
              ),
            MainAgentRunning: (e) =>
              Effect.fail(
                new Forbidden({
                  method: "Project.CoordinatorSession",
                  message: `the main agent (${e.harness}) is still running in ${e.place}, and a project has one main agent; exit it there first, or run vibest here on an interactive terminal and answer y to move it here`,
                }),
              ),
          }),
        ),

      "Project.FocusCoordinator": () =>
        Effect.gen(function* () {
          const c = yield* cliOnly("Project.FocusCoordinator")
          const project = yield* resolveAt(c.repositoryRoot)
          return yield* mainAgent.focus(project.id)
        }),

      "Project.RunningCoordinator": ({ terminal }) =>
        scope("Project.RunningCoordinator").pipe(Effect.flatMap(({ id }) => mainAgent.running(id, terminal))),

      "Project.StopCoordinator": ({ runtime, address }) =>
        Effect.gen(function* () {
          const { id } = yield* scope("Project.StopCoordinator")
          return yield* mainAgent
            .stop(id, runtime, address)
            .pipe(
              Effect.catchTag("NoRuntime", (e) =>
                Effect.fail(new InvalidCaller({ method: "Project.StopCoordinator", message: e.message })),
              ),
            )
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
        mainAgent.ready(sessionId, harness, harnessSessionId),
      "Project.Create": ({ directory, from }) =>
        Effect.gen(function* () {
          const c = yield* cliOnly("Project.Create")
          const created = yield* createProject(directory, from, c.repositoryRoot)
          return {
            directory: created.directory,
            folders: created.folders.map((folder) => ({
              name: folder.name,
              source: folder.source,
              path: folder.path,
              branch: folder.branch,
              uncommitted: [...folder.uncommitted],
              ...(folder.origin === undefined ? {} : { origin: folder.origin }),
            })),
          }
        }),

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
            spawnDaemon(command, ["--import"]).pipe(
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

export const socketServer = LayerNode.unbound<SocketServer.SocketServerError>()(SocketServer.SocketServer)

export const node = LayerNode.make({
  name: "vibest/RpcServer",
  layer,
  deps: [
    services,
    Bus.node,
    Db.node,
    Drain.node,
    Git.node,
    Harness.node,
    Harnesses.node,
    Identity.node,
    Inbox.node,
    MainAgent.node,
    Machines.node,
    Peers.node,
    Plugins.node,
    Processes.node,
    Project.node,
    Remote.node,
    Runtimes.node,
    Sessions.node,
    Shutdown.node,
    SshHosts.node,
    Subscriptions.node,
    UpdateCheckNode.node,
    VibestdIdentity.node,
    socketServer,
    PlatformNode.childProcessSpawner,
    PlatformNode.fileSystem,
    PlatformNode.layout,
    PlatformNode.path,
  ],
})
