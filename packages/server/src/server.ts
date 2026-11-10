import { importCheck, spawnDaemon } from "@vibest/client/client"
import { raisesSeen } from "@vibest/core/activity"
import { awaitEvent, Bus, type EngineEvent } from "@vibest/core/bus"
import { callerTarget, filterCallerEnv, mainPlace, specHits } from "@vibest/core/caller"
import { AddressJson, Db, encodeAddress } from "@vibest/core/db"
import { Drain } from "@vibest/core/drain"
import { LayerNode } from "@vibest/core/effect/layer-node"
import * as PlatformNode from "@vibest/core/effect/platform"
import { Harness, harnessOptions, Harnesses, HarnessUnavailable } from "@vibest/core/harness"
import type { HarnessDefinition } from "@vibest/core/host"
import { VibestdIdentity } from "@vibest/core/identity"
import { coordinatorIdle, Inbox } from "@vibest/core/inbox"
import { keyedLock } from "@vibest/core/keyed-lock"
import * as Launch from "@vibest/core/launch"
import { Machines } from "@vibest/core/machines"
import { Layout, shellQuote } from "@vibest/core/paths"
import { Peers } from "@vibest/core/peer"
import { describeSpawn, Plugins } from "@vibest/core/plugins"
import { Processes } from "@vibest/core/processes"
import { Project } from "@vibest/core/project"
import { createProject } from "@vibest/core/project-create"
import { locateProject, resolveProject } from "@vibest/core/project-identity"
import { Remote } from "@vibest/core/remote"
import { HARNESS_EXIT_WAIT, stopAgent } from "@vibest/core/remove"
import { SshHosts } from "@vibest/core/repository-url"
import { Restarting } from "@vibest/core/restarting"
import { envelope } from "@vibest/core/results"
import { machinesListing, NoRuntime, Runtimes, type Terminal } from "@vibest/core/runtimes"
import { defaultSessionName, NoSuchSession, runtimeEnv, Sessions } from "@vibest/core/sessions"
import { Subscriptions } from "@vibest/core/subscriptions/service"
import * as UpdateCheckNode from "@vibest/core/update-check"
import { UpdateCheck } from "@vibest/core/update-check"
import { Git, NotInRepository } from "@vibest/core/worktree"
import { PROTOCOL } from "@vibest/protocol/protocol"
import {
  type ACCESS,
  Caller,
  CAPABILITIES,
  DaemonBusy,
  type DaemonIdentity,
  DaemonStopping,
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
import { Clock, Context, Deferred, Duration, Effect, Layer, Option, Queue, Schema, Stream } from "effect"
import * as Headers from "effect/http/Headers"
import { ChildProcessSpawner } from "effect/process"
import { RpcSerialization, RpcServer } from "effect/rpc"
import * as SocketServer from "effect/socket/SocketServer"

import { AdmissionLive, CallerGateLive, noteOpen, ProtocolGateLive, reader } from "./gates.ts"
import * as Hooks from "./hooks.ts"
import { integrationHandlers } from "./integration.ts"
import { placeOf, sameCoordinator, sessionListing, toInfo } from "./listing.ts"
import { remoteHandlers } from "./remote-handlers.ts"

type Access = typeof ACCESS
type MethodOf<A> = { [K in keyof Access]: Access[K] extends A | readonly [A, "peer"] ? K : never }[keyof Access]

export class Identity extends Context.Service<Identity, DaemonIdentity>()("vibest/DaemonIdentity") {
  static readonly node = LayerNode.unbound(Identity)
}

export class Shutdown extends Context.Service<Shutdown, Deferred.Deferred<void>>()("vibest/DaemonShutdown") {
  static readonly node = LayerNode.unbound(Shutdown)
}

export const HANDOFF_ENV = "VIBEST_HANDOFF_ENV"

export const DRAIN_TIMEOUT = Duration.seconds(5)
export const PRESENT_TIMEOUT = Duration.seconds(5)

export const WATCH_BACKLOG = 10_000

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
    const updateStatus = yield* UpdateCheck
    const shutdown = yield* Shutdown
    const drain = yield* Drain
    const bus = yield* Bus
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const harnesses = yield* Harnesses

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
    const projectLocked = keyedLock<string>()
    const seenLocked = keyedLock<string>()

    const runningCoordinator = (projectId: string, terminal: string) =>
      Effect.gen(function* () {
        const coord = yield* db.coordinatorOf(projectId)
        if (!coord?.address || coord.address.id === "" || !coord.runtime) return null
        if (coord.address.id === terminal) return null
        if (!restarting.has(coord.id)) {
          const h = runtimes.find(coord.runtime)
          if (h === undefined) return null
          const presence = yield* coordinatorIdle(h, coord.address).pipe(Effect.option)
          if (Option.isNone(presence) || (presence.value !== "idle" && presence.value !== "busy")) return null
        }
        return {
          harness: coord.harnessId,
          place: placeOf(coord.runtime, coord.address),
          runtime: coord.runtime,
          address: encodeAddress(coord.address),
        }
      })
    const { listed, watched, snapshotProjects, watchDeltas } = sessionListing({ db, sessions, runtimes })

    const integration = yield* integrationHandlers
    const harnessIds = () => harnesses.all.map((definition) => definition.id)
    const firstStart = new LaunchFailed({
      message: "no harness to inherit: pass --harness, for example `vibest --harness claude`",
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
          const { id, directory: root } = yield* scope("Launch")
          const at = yield* machineFromCaller({ callerEnv, runtimeSession })
          const current = yield* db.coordinatorOf(id)
          const asked = Launch.flagValue(argv, "--harness")
          const decision = yield* plugins.start({
            project: root,
            agentType: "main",
            parentSessionId: undefined,
            prompt: "",
            harness: asked ?? current?.harnessId,
            provider: Launch.flagValue(argv, "--provider"),
            model: Launch.flagValue(argv, "--model"),
            harnesses: yield* harnessOptions,
            attempts: [],
            machine: { id: at.id },
            runtime,
            parentRuntime: current?.runtime ?? undefined,
            machines: yield* machinesListing(runtimes, harnessIds()).pipe(Effect.orElseSucceed(() => [])),
          })
          if (decision.runtime === undefined) {
            const loaded = (yield* runtimes.all).map((h) => h.id)
            return yield* new NoRuntime({
              message: `no terminal runtime was chosen for the main agent${loaded.length === 0 ? "" : `; loaded: ${loaded.join(", ")}`}`,
            })
          }
          if (decision.harness === undefined) return yield* firstStart
          if (harnesses.find(decision.harness) === undefined)
            return yield* new LaunchFailed({
              message: `unknown harness ${decision.harness}; loaded: ${harnessIds().join(", ")}`,
            })
          const harness = decision.harness
          const rt = yield* runtimes.route(decision.runtime)
          yield* runtimes.online(rt, { id: decision.machine.id })
          const run = rt.run
          if (run === undefined)
            return yield* new LaunchFailed({ message: "this runtime cannot type a command into the pane it opened" })
          const fresh = argv.includes("--new")
          let opened: Terminal | undefined
          let claimedId: string | undefined
          const command = yield* Launch.coordinatorCommand({
            harness,
            root,
            provider: decision.provider ?? null,
            model: decision.model ?? null,
            session: projectLocked.withLock(id)(
              Effect.gen(function* () {
                const running = yield* runningCoordinator(id, "")
                if (running)
                  return yield* new Forbidden({
                    method: "Launch",
                    message: `the main agent (${running.harness}) is still running in ${running.place}, and a project has one main agent; exit it there first`,
                  })
                const existing = yield* db.coordinatorOf(id)
                const sessionId =
                  existing === undefined || fresh ? yield* db.allocateSessionId().pipe(Effect.orDie) : existing.id
                const pane = yield* Launch.openInParentWorkspace(rt, at, {
                  root,
                  label: "vibest",
                  home: layout.home,
                  focus,
                })
                opened = pane
                const claimed = yield* db
                  .coordinatorLaunch(
                    id,
                    harness,
                    fresh,
                    { runtime: rt.id, address: pane },
                    {
                      provider: decision.provider,
                      model: decision.model,
                      routing: { decidedBy: decision.decidedBy, trace: decision.trace },
                      projectDirectory: root,
                      ...(existing === undefined || fresh ? { sessionId } : {}),
                    },
                  )
                  .pipe(Effect.tapError(() => rt.close(pane).pipe(Effect.ignore)))
                claimedId = claimed.sessionId
                return { ...claimed, runtime: runtimeEnv(rt.id, pane) }
              }),
            ),
          }).pipe(
            Effect.catchTag("HarnessUnavailable", (error) => Effect.fail(new LaunchFailed({ message: error.message }))),
            Effect.catchTag("SystemPromptDirUnsafe", (error) =>
              Effect.fail(new LaunchFailed({ message: error.message })),
            ),
            Effect.tapError(() =>
              opened === undefined
                ? Effect.void
                : rt
                    .close(opened)
                    .pipe(
                      Effect.ignore,
                      Effect.andThen(claimedId === undefined ? Effect.void : db.endProcess(claimedId, "launch_failed")),
                    ),
            ),
          )
          if (opened === undefined) return yield* Effect.die("launch opened no terminal")
          const pane = opened
          yield* run(pane, Launch.restartArgv(command)).pipe(
            Effect.catch((error) =>
              rt
                .close(pane)
                .pipe(
                  Effect.ignore,
                  Effect.andThen(claimedId === undefined ? Effect.void : db.endProcess(claimedId, "launch_failed")),
                  Effect.andThen(Effect.fail(new LaunchFailed({ message: error.message }))),
                ),
            ),
          )
          const routing =
            Object.keys(decision.decidedBy).length === 0
              ? undefined
              : describeSpawn({
                  harness,
                  provider: decision.provider,
                  model: decision.model,
                  decidedBy: decision.decidedBy,
                })
          return {
            runtime: rt.id,
            terminal: pane.id,
            place: placeOf(rt.id, pane),
            attach: rt.attach?.(at) ?? null,
            ...(routing === undefined ? {} : { routing }),
          }
        }),

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
            parentRuntime: current?.runtime ?? undefined,
            machines: yield* machinesListing(runtimes, harnessIds()).pipe(Effect.orElseSucceed(() => [])),
          })
          if (decision.harness === undefined) return yield* firstStart
          if (harnesses.find(decision.harness) === undefined)
            return yield* new HarnessUnavailable({
              harness: decision.harness,
              message: `unknown harness ${decision.harness}; loaded: ${harnessIds().join(", ")} (routed: ${describeSpawn({ ...decision, harness: decision.harness })})`,
            })
          if (decision.runtime === undefined)
            return yield* new NoRuntime({ message: "no terminal runtime was chosen for the main agent" })
          const rt = yield* runtimes.route(decision.runtime)
          yield* runtimes.online(rt, { id: decision.machine.id })
          return { ...decision, harness: decision.harness, runtime: rt.id }
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
                message: spec.missing ?? `this ${place.runtime} terminal could not be named`,
              })
          }
          return { directory: project.directory, place }
        }),

      "Project.CoordinatorSession": ({ harness, fresh, terminal, runtime, provider, model, routing, pid }) =>
        Effect.gen(function* () {
          const { id: projectId, directory } = yield* scope("Project.CoordinatorSession")
          const kind = runtime ?? (yield* onlyRuntime)?.id
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
              const address = { machine: "local", id: terminal }
              let claimed:
                | {
                    readonly sessionId: string
                    readonly harnessSessionId: string | null
                    readonly projectId: string
                    readonly runtime: string
                  }
                | undefined
              const command = yield* Launch.coordinatorCommand({
                harness,
                root: directory,
                provider: provider ?? null,
                model: model ?? null,
                session: Effect.gen(function* () {
                  const saved = yield* db.coordinatorLaunch(
                    projectId,
                    harness,
                    fresh,
                    { runtime: kind, address },
                    { provider, model, routing, pid, projectDirectory: directory },
                  )
                  claimed = { ...saved, runtime: runtimeEnv(kind, address) }
                  return claimed
                }),
              }).pipe(
                Effect.catchTag("SystemPromptDirUnsafe", (error) =>
                  Effect.fail(new LaunchFailed({ message: error.message })),
                ),
              )
              if (claimed === undefined) return yield* Effect.die("coordinator command returned without a session")
              const rt = runtimes.find(kind)
              if (rt?.present !== undefined)
                yield* rt
                  .present(address, { mainSession: claimed.sessionId, projectId })
                  .pipe(Effect.timeout(PRESENT_TIMEOUT), Effect.ignore)
              return {
                sessionId: claimed.sessionId,
                harnessSessionId: claimed.harnessSessionId,
                projectId: claimed.projectId,
                runtime: claimed.runtime,
                command: { file: command.file, args: [...command.args], env: { ...command.env } },
              }
            }),
          )
        }),

      "Project.FocusCoordinator": () =>
        Effect.gen(function* () {
          const c = yield* cliOnly("Project.FocusCoordinator")
          const project = yield* resolveAt(c.repositoryRoot)
          const running = yield* runningCoordinator(project.id, "")
          if (running === null) return null
          const runtime = runtimes.find(running.runtime)
          if (runtime?.focus === undefined) return { place: running.place, focused: false }
          const address = yield* Schema.decodeUnknownEffect(AddressJson)(running.address).pipe(Effect.orDie)
          const focused = yield* runtime.focus(address).pipe(Effect.exit)
          return { place: running.place, focused: focused._tag === "Success" }
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
    Bus.node,
    Db.node,
    Drain.node,
    Git.node,
    Harness.node,
    Harnesses.node,
    Identity.node,
    Inbox.node,
    Machines.node,
    Peers.node,
    Plugins.node,
    Processes.node,
    Project.node,
    Remote.node,
    Restarting.node,
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
