import { newId, shortId } from "@vibest/schema/id"
import type { AgentRefused } from "@vibest/schema/plugin"
import {
  AllocationFailed,
  LimitReached,
  NoHarnessChosen,
  NoRuntime,
  NoSuchSession,
  NotReady,
  RuntimeUnreachable,
  SessionBusy,
} from "@vibest/schema/session"
import {
  Cause,
  Clock,
  Config,
  Context,
  Crypto,
  Deferred,
  Duration,
  Effect,
  Exit,
  FileSystem,
  HashMap,
  Layer,
  Option,
  Path,
  PlatformError,
  Predicate,
  PubSub,
  Ref,
  Schedule,
  SynchronizedRef,
} from "effect"
import type { Scope } from "effect"
import { Hex } from "effect/encoding"
import { ChildProcessSpawner } from "effect/process"

import { awaitEvent, awaitOn, Bus, type EngineEvent } from "./bus.ts"
import { Db, type InboxRow, type SessionRow } from "./db.ts"
import { Drain } from "./drain.ts"
import * as Engine from "./engine.ts"
import {
  encodeCommand,
  harnessOptions,
  Harness,
  Harnesses,
  HarnessUnavailable,
  type HarnessId,
  isHarnessId,
  preflight,
  type HarnessAdapter,
} from "./harness.ts"
import { Inbox } from "./inbox.ts"
import { keyedLock } from "./keyed-lock.ts"
import { coordinatorCommand, restartArgv } from "./launch.ts"
import { limitMoveBox, sessionMove } from "./move.ts"
import { ALLOCATION_LEAF, ALLOCATION_NAME_ATTEMPTS, Layout, VibestCommand, safeRepositoryDirectory } from "./paths.ts"
import { sessionPlacement } from "./placement.ts"
import { describeSpawn, errorMessage, Plugins, type Routing } from "./plugins.ts"
import { Processes } from "./processes.ts"
import { listProjectRepositories, projectRoot, workspaceGit } from "./project-create.ts"
import * as Remove from "./remove.ts"
import { type Outdated, type Restarted, sessionRestart } from "./restart.ts"
import { Restarting } from "./restarting.ts"
import { sessionRounds } from "./rounds.ts"
import {
  agentState,
  type AgentState,
  alive,
  type Machine,
  machinesListing as machines,
  paneTail,
  peekHint,
  Runtimes,
  RuntimeError,
  type Runtime,
  stateOf,
  type Terminal,
  type AgentSeen,
} from "./runtimes.ts"
import { Subscriptions } from "./subscriptions/service.ts"
import { projectText, sessionSystemPrompt, writeSystemPrompt } from "./system-prompt.ts"
import { allocationParentBlocked, gitState, type GitState, mainCheckout, repositoryDirectoryName } from "./worktree.ts"
export const runtimeEnv = (runtime: string, address: { readonly machine: string; readonly id: string }) =>
  JSON.stringify({ runtime, machine: address.machine, ...(address.id !== "" ? { terminal: address.id } : {}) })

export {
  AllocationFailed,
  LaunchFailed,
  LimitReached,
  NoHarnessChosen,
  NoRuntime,
  NoSuchSession,
  NotReady,
  RuntimeUnreachable,
  SessionBusy,
} from "@vibest/schema/session"

const directoryLock = (directory: string) => `directory:${directory}`

export const peerAdmitPause: { wait: Effect.Effect<void> } = { wait: Effect.void }
export const allocationNameSource: { leaves: ReadonlyArray<string> | undefined } = { leaves: undefined }

export const START_TIMEOUT = Duration.seconds(120)
export const READY_TIMEOUT = Duration.seconds(60)
export const CONFIRM_TIMEOUT = Duration.seconds(8)
export const HOOK_GRACE = Duration.seconds(10)
export const TAIL_LINES = 30
export const STOP_WAIT = Duration.seconds(10)
const STARTUP_DIALOG_POLL = Schedule.spaced("500 millis")

type Platform = FileSystem.FileSystem | Path.Path | Crypto.Crypto | ChildProcessSpawner.ChildProcessSpawner

interface Tracked {
  readonly sawWorking: Ref.Ref<boolean>
  readonly endedAt: Ref.Ref<number | undefined>
  readonly blockedNotified: Ref.Ref<boolean>
  readonly prompting: Ref.Ref<boolean>
  readonly stopping: Ref.Ref<boolean>
  readonly launchRechecked: Ref.Ref<boolean>
}

const newTracked: Effect.Effect<Tracked> = Effect.all({
  sawWorking: Ref.make(false),
  endedAt: Ref.make<number | undefined>(undefined),
  blockedNotified: Ref.make(false),
  prompting: Ref.make(false),
  stopping: Ref.make(false),
  launchRechecked: Ref.make(false),
})

export interface SpawnInput {
  readonly machine: Machine
  readonly root: string
  readonly projectId: string
  readonly name: string
  readonly prompt: string
  readonly harness?: HarnessId | undefined
  readonly provider?: string | undefined
  readonly model?: string | undefined
  readonly env?: Record<string, string> | undefined
  readonly agent?: string | undefined
  readonly peer?: string | undefined
  readonly archive?: boolean | undefined
  readonly runtime?: string | undefined
  readonly parentSessionId?: string | undefined
  readonly request?: string | undefined
}

export interface Spawned extends Routing {
  readonly id: string
  readonly harness: HarnessId
  readonly provider: string | undefined
  readonly model: string | undefined
  readonly runtime: string
}

export interface SessionView extends SessionRow {
  readonly worktree: string
  readonly repositoryRoot: string | undefined
  readonly git: GitState | undefined
}

export class Sessions extends Context.Service<
  Sessions,
  {
    readonly spawn: (
      input: SpawnInput,
    ) => Effect.Effect<
      Spawned,
      AllocationFailed | LimitReached | HarnessUnavailable | NoHarnessChosen | NoRuntime | AgentRefused | NoSuchSession,
      Scope.Scope
    >
    readonly send: (id: string, message: string, request?: string) => Effect.Effect<void, NoSuchSession>
    readonly interrupt: (
      id: string,
    ) => Effect.Effect<{ message: string }, NoRuntime | NoSuchSession | SessionBusy | RuntimeUnreachable>
    readonly remove: (
      id: string,
      options?: { readonly keepWorktree?: boolean | undefined },
    ) => Effect.Effect<
      Remove.RemoveOutcome | undefined,
      NoRuntime | NoSuchSession | SessionBusy | RuntimeUnreachable | RuntimeError
    >
    readonly get: (id: string) => Effect.Effect<SessionView, NoSuchSession>
    readonly peek: (id: string, lines: number) => Effect.Effect<string, NoSuchSession | NoRuntime | RuntimeUnreachable>
    readonly list: (filter?: { projectId?: string; stopped?: boolean }) => Effect.Effect<ReadonlyArray<SessionView>>
    readonly check: (id: string) => Effect.Effect<void>
    readonly userPrompt: (id: string, text: string, at?: number) => Effect.Effect<void, never, FileSystem.FileSystem>
    readonly republish: Effect.Effect<number>
    readonly inMemory: Effect.Effect<{
      readonly tracked: number
      readonly locks: number
    }>
    readonly outdated: Effect.Effect<ReadonlyArray<Outdated>>
    readonly restart: (ids: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<Restarted>>
    readonly restartLater: (ids: ReadonlyArray<string>, after: number | undefined) => Effect.Effect<void>
  }
>()("vibest/Sessions") {
  static readonly make = (options: { readonly maxSessions: number | undefined }) =>
    Effect.gen(function* () {
      const db = yield* Db
      const runtimes = yield* Runtimes
      const harness = yield* Harness
      const harnesses = yield* Harnesses
      const inbox = yield* Inbox
      const drain = yield* Drain
      const layout = yield* Layout
      const fs = yield* FileSystem.FileSystem
      const crypto = yield* Crypto.Crypto
      const path = yield* Path.Path
      const vibest = yield* VibestCommand
      const plugins = yield* Plugins
      const removal = yield* Remove.make
      const processes = yield* Processes
      const restarting = yield* Restarting
      const bus = yield* Bus
      const platform = yield* Effect.context<Platform>()
      const scope = yield* Effect.scope
      const engine = yield* Engine.make

      const tracked = yield* SynchronizedRef.make(HashMap.empty<string, Tracked>())
      const track = (id: string) =>
        SynchronizedRef.modifyEffect(tracked, (map) =>
          Option.match(HashMap.get(map, id), {
            onSome: (r) => Effect.succeed([r, map] as const),
            onNone: () => newTracked.pipe(Effect.map((r) => [r, HashMap.set(map, id, r)] as const)),
          }),
        )
      const locks = keyedLock<string>()
      const stop = (id: string) =>
        SynchronizedRef.modifyEffect(tracked, (map) =>
          Effect.gen(function* () {
            const r = Option.getOrUndefined(HashMap.get(map, id)) ?? (yield* newTracked)
            const already = yield* Ref.getAndSet(r.stopping, true)
            return [{ r, already }, HashMap.set(map, id, r)] as const
          }),
        )
      const forget = (id: string) =>
        locks.withLock(id)(
          SynchronizedRef.updateEffect(tracked, (map) =>
            Effect.gen(function* () {
              const row = yield* db.getSession(id)
              if (row !== undefined && row.exitedAt === null && !row.metadata.archived && !row.metadata.removed)
                return map
              const r = Option.getOrUndefined(HashMap.get(map, id))
              if (r !== undefined && ((yield* Ref.get(r.stopping)) || (yield* Ref.get(r.prompting)))) return map
              yield* engine.cancel(`grace:${id}`)
              yield* engine.cancel(`miss:${id}`)
              return HashMap.remove(map, id)
            }),
          ),
        )
      const locked =
        (id: string, settlement = false) =>
        <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          drain.work(`session ${id}`, locks.withLock(id)(effect), settlement)
      const logged =
        (what: string) =>
        <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          effect.pipe(Effect.catchCause((cause) => Effect.logWarning(`${what}: ${Cause.pretty(cause)}`)))

      const sessionAt = (terminal: Terminal) =>
        db
          .listSessions()
          .pipe(
            Effect.map(
              (rows) =>
                rows.find((row) => row.address.machine === terminal.machine && row.address.id === terminal.id)?.id,
            ),
          )

      const notice = (session: SessionRow, message: string) =>
        inbox.enqueue({ sessionId: session.id, kind: "notice", message, details: {} })

      const worktreeOf = (session: SessionRow) =>
        db.sessionDirectory(session.id).pipe(
          Effect.flatMap((directory) =>
            directory
              ? Effect.succeed(directory)
              : Effect.fail(
                  new NoSuchSession({
                    id: session.id,
                    message: `${session.id} records no directory; nothing was deleted`,
                  }),
                ),
          ),
        )

      const undelivered = (
        session: SessionRow,
        rows: ReadonlyArray<{ readonly id: number; readonly message: string }>,
        reason: string,
      ) =>
        db
          .setInboxStatus(
            rows.map((r) => r.id),
            "failed",
          )
          .pipe(
            Effect.andThen(
              notice(
                session,
                `A message to ${session.id} was not delivered: ${reason}\n\n${rows.map((r) => r.message).join("\n\n")}`,
              ),
            ),
          )

      const dropQueue = (session: SessionRow, reason: string) =>
        db
          .pendingInbox(session.id)
          .pipe(Effect.flatMap((rows) => (rows.length === 0 ? Effect.void : undelivered(session, rows, reason))))

      const live = (session: SessionRow) => runtimes.route(session.runtime)

      const settled = (seen: AgentSeen) => seen !== "absent" && seen !== "unknown"
      const awaitReady = (h: Runtime, terminal: Terminal, adapter: HarnessAdapter, id: string) =>
        Effect.gen(function* () {
          const reports = adapter.ready === "integration"
          if (h.state === undefined && !reports) return "unknown" as AgentState
          const step = adapter.startup ? yield* adapter.startup : undefined
          const screen = h.read(terminal, 40).pipe(Effect.orElseSucceed(() => ""))
          const look = Effect.gen(function* () {
            const seen: AgentSeen = h.state === undefined ? "unknown" : yield* agentState(h, terminal)
            const ready = (yield* db.readyAt(id)) !== undefined || (!reports && settled(seen))
            return { seen, ready }
          })
          return yield* look.pipe(
            Effect.flatMap((now) => {
              if (now.ready || settled(now.seen) || step === undefined) return Effect.succeed(now)
              return step({
                screen,
                sendKeys: (keys) => h.send(terminal, { keys: [...keys] }).pipe(Effect.ignore),
              }).pipe(Effect.as(now))
            }),
            Effect.repeat({ until: (now) => now.ready, schedule: STARTUP_DIALOG_POLL }),
            Effect.timeoutOrElse({
              duration: READY_TIMEOUT,
              orElse: () =>
                screen.pipe(
                  Effect.flatMap((tail) => Effect.logInfo(`not ready ${id}: terminal tail\n${tail.trim()}`)),
                  Effect.andThen(
                    Effect.fail(
                      new NotReady({
                        id,
                        message: `${id} did not become ready in ${Duration.format(READY_TIMEOUT)} (a startup dialog vibest could not answer? open ${adapter.id} once in the repository and accept it)`,
                      }),
                    ),
                  ),
                ),
            }),
            Effect.map((now): AgentState =>
              reports && !settled(now.seen) ? "idle" : (stateOf(now.seen) ?? "unknown"),
            ),
          )
        })

      const vibestEnv = (session: SessionRow) => ({
        VIBEST_SESSION_ID: session.id,
        VIBEST_PROJECT_ID: session.projectId,
        VIBEST_PROJECT_DIR: layout.project(session.projectId),
        VIBEST_AGENT: session.agent,
        VIBEST_HARNESS: session.harnessId,
        VIBEST_RUNTIME: runtimeEnv(session.runtime, { machine: session.address.machine, id: "" }),
        VIBEST_HOME: layout.home,
        VIBEST_COMMAND: encodeCommand(vibest),
      })

      const systemPromptOf = (session: SessionRow) =>
        Effect.gen(function* () {
          return sessionSystemPrompt({
            id: session.id,
            peer: yield* db.earlierSharer(session.id),
            projectDir: layout.project(session.projectId),
            vibest,
            ...(yield* projectText(layout.project(session.projectId))),
          })
        })

      const launchArgv = Effect.fn("Sessions.launchArgv")(function* (session: SessionRow, resume: boolean) {
        const file = yield* systemPromptOf(session).pipe(
          Effect.flatMap((text) => writeSystemPrompt(session.id, text)),
          Effect.provideContext(platform),
        )
        const adapter = harnesses.get(session.harnessId)
        const pluginDir = yield* harness.plugin(adapter.id)
        return [
          adapter.binary,
          ...adapter.launchArgs({
            worktree: yield* worktreeOf(session),
            projectDir: layout.project(session.projectId),
            systemPromptFile: file,
            provider: session.provider,
            model: session.model,
            sessionId: session.harnessSessionId,
            resume,
            pluginDir,
            vibest,
            env: vibestEnv(session),
          }),
        ]
      })

      const sameTerminal = (a: Terminal, b: Terminal) => a.machine === b.machine && a.id === b.id
      const sawTurnStart = (id: string) => Effect.flatMap(track(id), (r) => Ref.set(r.sawWorking, true))

      const pickedUp = (session: SessionRow, state: "working" | "blocked") =>
        Effect.gen(function* () {
          yield* Ref.set((yield* track(session.id)).sawWorking, true)
          yield* db.updateSession(session.id, { status: state })
          return true
        })

      const pickupNow = (h: Runtime, session: SessionRow, terminal: Terminal) =>
        Effect.gen(function* () {
          const state = stateOf(yield* agentState(h, terminal))
          if (state === "working" || state === "blocked") return yield* pickedUp(session, state)
          return yield* Ref.get((yield* track(session.id)).sawWorking)
        })

      const confirmed = (
        h: Runtime,
        session: SessionRow,
        terminal: Terminal,
        subscription: PubSub.Subscription<EngineEvent>,
      ) =>
        awaitOn(
          subscription,
          pickupNow(h, session, terminal).pipe(Effect.map((picked) => (picked ? Option.some(true) : Option.none()))),
          (event) =>
            event.type === "live.turn_start" && event.sessionId === session.id && event.at >= session.turnPromptedAt
              ? Effect.as(sawTurnStart(session.id), Option.some(true))
              : event.type === "live.state" &&
                  sameTerminal(event.terminal, terminal) &&
                  (event.state === "working" || event.state === "blocked")
                ? Effect.map(pickedUp(session, event.state), Option.some)
                : Effect.succeed(Option.none()),
          CONFIRM_TIMEOUT,
          pickupNow(h, session, terminal),
        )

      const busy = (state: AgentState) => state === "working" || state === "blocked"
      const busyOf = (seen: AgentSeen) => {
        const state = stateOf(seen)
        return state !== undefined && busy(state)
      }

      const settleAfterInterrupt = (h: Runtime, session: SessionRow, terminal: Terminal) => {
        const settledNow = agentState(h, terminal).pipe(
          Effect.map((seen) => {
            const state = stateOf(seen)
            return state !== undefined && state !== "working" && state !== "blocked"
          }),
        )
        return awaitEvent(
          settledNow.pipe(Effect.map((idle) => (idle ? Option.some(true) : Option.none()))),
          (event) =>
            Effect.succeed(
              (event.type === "live.state" &&
                sameTerminal(event.terminal, terminal) &&
                event.state !== "working" &&
                event.state !== "blocked") ||
                (event.type === "turn.reported" && event.sessionId === session.id)
                ? Option.some(true)
                : Option.none(),
            ),
          STOP_WAIT,
          settledNow,
        ).pipe(Effect.provideService(Bus, bus))
      }
      const interruptAgent = (h: Runtime, session: SessionRow, terminal: Terminal) =>
        Effect.gen(function* () {
          yield* h.send(terminal, { keys: [harnesses.get(session.harnessId).interruptKey] }).pipe(Effect.ignore)
          return yield* settleAfterInterrupt(h, session, terminal)
        })

      type Collected = "none" | "delivered"
      let collectResult: (
        h: Runtime | undefined,
        session: SessionRow,
      ) => Effect.Effect<
        Collected,
        RuntimeError | NoSuchSession | PlatformError.PlatformError,
        ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
      > = () => Effect.die("collectResult")

      const prompt = Effect.fn("Sessions.prompt")(function* (
        h: Runtime,
        session: SessionRow,
        terminal: Terminal,
        text: string,
        onHandover: Effect.Effect<void> = Effect.void,
        options?: { readonly keepRound?: boolean },
      ) {
        const openedHere = session.turnState !== "open"
        if (openedHere) {
          const at = yield* Clock.currentTimeMillis
          yield* db.updateSession(session.id, { turnState: "open", turnPromptedAt: at, lastActive: at })
        }
        const adapter = harnesses.get(session.harnessId)
        const state = yield* awaitReady(h, terminal, adapter, session.id).pipe(
          Effect.onExit((exit) =>
            openedHere && !Exit.isSuccess(exit)
              ? Effect.uninterruptible(
                  Effect.flatMap(Clock.currentTimeMillis, (t) =>
                    db.updateSession(session.id, { turnState: "not_started", lastActive: t }),
                  ),
                )
              : Effect.void,
          ),
        )
        const now = yield* Clock.currentTimeMillis
        yield* onHandover
        const r = yield* track(session.id)
        yield* Ref.set(r.endedAt, undefined)
        yield* Ref.set(r.blockedNotified, false)
        yield* Ref.set(r.sawWorking, false)
        yield* db.updateSession(session.id, { status: state, turnState: "open", turnPromptedAt: now, lastActive: now })
        const send = Ref.set(r.prompting, true).pipe(
          Effect.andThen(h.send(terminal, { text })),
          Effect.ensuring(Ref.set(r.prompting, false)),
        )
        const missed = options?.keepRound
          ? Effect.void
          : db.updateSession(session.id, { turnState: "not_started", lastActive: yield* Clock.currentTimeMillis })
        const subscription = yield* bus.subscribe
        const delivered = yield* send.pipe(
          Effect.as(false),
          Effect.catchTag("RuntimeError", (error) =>
            Effect.gen(function* () {
              if ((yield* collectResult(h, session).pipe(Effect.provideContext(platform), Effect.orDie)) !== "none")
                return true
              if (error.code === "unreachable") return yield* Effect.fail(error)
              yield* missed
              return yield* error
            }),
          ),
        )
        if (delivered) return undefined
        if (state === "unknown" && adapter.ready === "runtime") {
          yield* sawTurnStart(session.id)
          yield* db.updateSession(session.id, { status: "working" })
          return undefined
        }
        const round = { ...session, turnPromptedAt: now }
        if (yield* confirmed(h, round, terminal, subscription)) return undefined
        yield* h.send(terminal, { keys: ["enter"] }).pipe(Effect.ignore)
        if (yield* confirmed(h, round, terminal, subscription)) return undefined
        yield* send.pipe(Effect.ignore)
        if (yield* confirmed(h, round, terminal, subscription)) return undefined
        if ((yield* collectResult(h, session).pipe(Effect.provideContext(platform), Effect.orDie)) !== "none")
          return undefined
        yield* Effect.logInfo(`task_not_started ${session.id}: terminal tail\n${yield* paneTail(h, terminal)}`)
        yield* missed
        return `task_not_started: ${session.id} did not start working on the message; ${peekHint(session.id)}`
      }, Effect.scoped)

      const limit = limitMoveBox()
      const rounds = sessionRounds({
        db,
        harnesses,
        track,
        lock: locks.withLock,
        worktreeOf,
        undelivered,
        logged,
        prompt,
        limitMove: limit.move,
      })
      collectResult = rounds.collectResult
      const { finish, deliverQueued, userPrompt } = rounds

      const handTask = (h: Runtime, session: SessionRow, terminal: Terminal, task: string) =>
        Effect.gen(function* () {
          const first = harnesses.get(session.harnessId).systemPromptInPrompt
            ? `${yield* systemPromptOf(session)}\n\n# Task\n\n${task}`
            : task
          const notStarted = yield* prompt(h, session, terminal, first, db.linkTask(session.id))
          if (notStarted) yield* notice(session, notStarted)
        })

      const afterOpen = (h: Runtime, session: SessionRow, terminal: Terminal, root: string, firstPrompt: string) =>
        Effect.gen(function* () {
          yield* show(h, session, terminal, root)
          yield* handTask(h, session, terminal, firstPrompt)
        })

      const { launch, resume, republish, recount, openTerminal, show, locate } = sessionPlacement({
        db,
        runtimes,
        layout,
        fs,
        path,
        harnesses,
        worktreeOf,
        vibestEnv,
        launchArgv,
        notice,
        prompt,
        limitMove: limit.move,
        afterOpen,
      })

      const move = sessionMove({
        db,
        plugins,
        subscriptions: yield* Subscriptions,
        harness,
        harnesses,
        track,
        prompt,
        open: openTerminal,
        show,
        locate,
        finish,
        launchArgv,
        systemPromptOf,
        uuid: newId(),
        terminate: processes.terminate,
        platform,
      })
      limit.move.rerun = move.rerun

      const machinesListing = machines(
        runtimes,
        harnesses.all.map((adapter) => adapter.id),
      )

      const chosenRuntime = (decision: {
        readonly machine: { readonly id: string }
        readonly runtime: string | undefined
      }) =>
        Effect.gen(function* () {
          if (decision.runtime === undefined) {
            const machines = yield* machinesListing
            const list = machines[0]!.runtimes
              .map((runtime) => `${runtime.kind}: ${runtime.status}${runtime.reason ? ` (${runtime.reason})` : ""}`)
              .join("; ")
            return yield* new NoRuntime({
              message: `no terminal runtime was chosen for this start (${list || "none is loaded"})`,
            })
          }
          const rt = yield* runtimes.route(decision.runtime)
          yield* runtimes.online(rt, { id: decision.machine.id })
          return rt
        })

      const peerOf = (input: SpawnInput, id: string, runtime: string, machineId: string) =>
        Effect.gen(function* () {
          const refuse = (why: string) => new NoSuchSession({ id, message: `--peer ${id}: ${why}` })
          const p = yield* db.getSession(id)
          if (!p) return yield* refuse(`no session ${id}`)
          if (p.projectId !== input.projectId) return yield* refuse("it belongs to another project")
          if (p.metadata.archived || p.metadata.removed) return yield* refuse("it was archived")
          if (p.runtime !== runtime || p.address.machine !== machineId)
            return yield* refuse(
              `ineligible: it runs in ${p.runtime} on ${p.address.machine}, not ${runtime} on ${machineId}`,
            )
          const worktree = yield* worktreeOf(p).pipe(Effect.mapError((e) => refuse(e.message)))
          if (!(yield* fs.exists(worktree).pipe(Effect.orDie)))
            return yield* refuse(`ineligible: its worktree ${worktree} is gone`)
          if (
            !(yield* listProjectRepositories(worktree).pipe(Effect.mapError((e) => refuse(e.message)))) &&
            !Option.contains(yield* mainCheckout(worktree).pipe(Effect.option), input.root)
          )
            return yield* refuse(`ineligible: its worktree is not in ${input.root}`)
          return worktree
        })

      const spawn = Effect.fn("Sessions.spawn")(function* (input: SpawnInput) {
        const root = input.root
        const agent = input.agent ?? "general"
        const worker = input.parentSessionId === undefined ? undefined : yield* db.getSession(input.parentSessionId)
        const main =
          worker === undefined && input.parentSessionId !== undefined
            ? yield* db.coordinatorOf(input.projectId)
            : undefined
        const parentRuntime =
          worker !== undefined
            ? worker.runtime || undefined
            : main !== undefined && main.id === input.parentSessionId
              ? main.runtime || undefined
              : undefined
        const decision = yield* plugins.start({
          project: root,
          agentType: agent,
          parentSessionId: input.parentSessionId,
          prompt: input.prompt,
          harness: input.harness,
          provider: input.provider,
          model: input.model,
          harnesses: yield* harnessOptions.pipe(
            Effect.provideService(Harness, harness),
            Effect.provideService(Harnesses, harnesses),
          ),
          attempts: [],
          machine: { id: input.machine.id },
          runtime: input.runtime,
          parentRuntime,
          machines: yield* machinesListing,
        })
        const { provider, model } = decision
        if (decision.harness === undefined) return yield* new NoHarnessChosen()
        const rt = yield* chosenRuntime(decision)
        const machine: Machine = {
          id: decision.machine.id,
          ...(input.machine.id === decision.machine.id && input.machine.target !== undefined
            ? { target: input.machine.target }
            : {}),
        }
        const runtimeKind = rt.kind
        const routed = (e: HarnessUnavailable) =>
          Object.keys(decision.decidedBy).length === 0
            ? e
            : new HarnessUnavailable({
                harness: e.harness,
                message: `${e.message} (routed: ${describeSpawn({ ...decision, harness: e.harness })})`,
              })
        const harnessId = decision.harness
        if (!isHarnessId(harnessId))
          return yield* routed(new HarnessUnavailable({ harness: harnessId, message: `unknown harness ${harnessId}` }))
        yield* preflight(harnessId, provider ?? null, model ?? null).pipe(
          Effect.provideService(Harness, harness),
          Effect.provideService(Harnesses, harnesses),
          Effect.mapError(routed),
        )
        const adapter = harnesses.get(harnessId)
        const routing: Routing = { decidedBy: decision.decidedBy, trace: decision.trace }
        const id = yield* db.newSessionId
        const now = yield* Clock.currentTimeMillis
        const admit = (shared: string | undefined) =>
          Effect.gen(function* () {
            const refuse = (message: string) => new AllocationFailed({ message })
            const folders = yield* listProjectRepositories(root).pipe(
              Effect.mapError((e) => refuse(`${root}: ${e.message}`)),
            )
            const base = {
              routing,
              ...(input.archive ? { archive: true } : {}),
            }
            let cwd = shared
            if (cwd === undefined) {
              const repository = folders
                ? path.basename(root)
                : yield* repositoryDirectoryName(root).pipe(Effect.mapError((e) => refuse(e.message)))
              if (!safeRepositoryDirectory(repository))
                return yield* refuse(
                  `repository name ${JSON.stringify(repository)} cannot be a directory under worktrees (empty, unsafe, or a session id)`,
                )
              const parentPath = path.join(layout.worktrees, repository)
              if (
                yield* allocationParentBlocked(parentPath).pipe(
                  Effect.mapError((e) => refuse(`${parentPath}: ${e.message}`)),
                )
              )
                return yield* refuse(
                  `refusing to allocate inside ${parentPath}: it is an existing worktree or not a directory`,
                )
              yield* fs.makeDirectory(parentPath, { recursive: true }).pipe(Effect.mapError((e) => refuse(e.message)))
              const scripted = allocationNameSource.leaves
              const attempts =
                scripted === undefined ? ALLOCATION_NAME_ATTEMPTS : Math.min(scripted.length, ALLOCATION_NAME_ATTEMPTS)
              for (let i = 0; i < attempts && cwd === undefined; i++) {
                const candidate = scripted?.[i] ?? Hex.encode(yield* crypto.randomBytes(2).pipe(Effect.orDie))
                if (!ALLOCATION_LEAF.test(candidate)) continue
                const where = layout.allocationWorktree(repository, candidate)
                const made = yield* fs.makeDirectory(where).pipe(
                  Effect.as(true),
                  Effect.catchTag("PlatformError", (e) =>
                    e.reason._tag === "AlreadyExists"
                      ? Effect.succeed(false)
                      : Effect.fail(refuse(`${where}: ${e.message}`)),
                  ),
                )
                if (made) cwd = where
              }
              if (cwd === undefined)
                return yield* refuse(`no unused 4-hex worktree name under ${repository} after ${attempts} attempts`)
            }
            const draft: Omit<SessionRow, "projectId"> = {
              id,
              agent,
              name: input.name,
              harnessId,
              provider: provider ?? null,
              model: model ?? null,
              harnessSessionId: adapter.ownSessionId ? yield* newId() : null,
              runtime: runtimeKind,
              address: { machine: machine.id, id: "" },
              status: "unknown",
              startedAt: null,
              exitedAt: null,
              turnState: "none",
              turnPromptedAt: 0,
              metadata: base,
              createdAt: now,
              lastActive: now,
            }
            const inserted = yield* db.insertSession(
              draft,
              input.projectId,
              options.maxSessions,
              cwd,
              decision.prompt,
              input.parentSessionId,
              input.request,
            )
            const unreserve =
              shared === undefined ? fs.remove(cwd, { recursive: true }).pipe(Effect.ignore) : Effect.void
            if (inserted === false) {
              yield* unreserve
              return yield* new LimitReached({ limit: options.maxSessions! })
            }
            if (inserted !== true) {
              yield* unreserve
              return { before: inserted }
            }
            return { row: (yield* db.getSession(id))! }
          })
        const admitted =
          input.peer === undefined
            ? yield* admit(undefined)
            : yield* locks.withLock(directoryLock((yield* db.sessionDirectory(input.peer)) ?? ""))(
                Effect.gen(function* () {
                  const shared = yield* peerOf(input, input.peer!, runtimeKind, decision.machine.id)
                  yield* peerAdmitPause.wait
                  return yield* admit(shared)
                }),
              )
        if ("before" in admitted) {
          const { before } = admitted
          return {
            id: before.id,
            harness: before.harness as HarnessId,
            provider: before.provider,
            model: before.model,
            runtime: before.runtime,
            decidedBy: before.routing?.decidedBy ?? {},
            trace: before.routing?.trace ?? [],
          }
        }
        const row = admitted.row
        const held = yield* Deferred.make<void>()
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const leave = drain.track(`spawn ${id}`)
            yield* Effect.forkIn(
              locks
                .withLock(id)(
                  Deferred.succeed(held, undefined).pipe(
                    Effect.andThen(launch(rt, machine, row, root, decision.prompt, input.peer, input.env)),
                  ),
                )
                .pipe(Effect.ensuring(leave), logged(`spawn ${id}`), Effect.provideContext(platform)),
              scope,
            )
          }),
        )
        yield* Deferred.await(held)
        return { id, harness: harnessId, provider, model, runtime: runtimeKind, ...routing }
      }, Effect.provideContext(platform))

      const undoCutOffStart = (h: Runtime, session: SessionRow) =>
        Effect.gen(function* () {
          const what = `${session.id} never finished starting (vibestd stopped while it started)`
          if (yield* db.hadTerminal(session.id)) return yield* notice(session, `${what}.`)
          const ended = yield* getRow(session.id)
          const out = yield* locks.withLock(directoryLock((yield* db.sessionDirectory(session.id)) ?? ""))(
            removal.release({ h, session: ended, terminal: undefined, keepWorktree: false, reasons: [] }),
          )
          let kept = out.worktree === "kept" ? out.reasons.join("; ") : undefined
          if (
            kept !== undefined &&
            (yield* fs.readDirectory(out.path).pipe(Effect.orElseSucceed(() => ["?"]))).length === 0
          ) {
            yield* fs.remove(out.path, { recursive: true }).pipe(Effect.ignore)
            kept = undefined
          }
          yield* notice(session, kept === undefined ? `${what}; its worktree was removed.` : `${what}; ${kept}.`)
        })

      const check = Effect.fn("Sessions.check")(function* (id: string) {
        const session = yield* db.getSession(id)
        if (!session) return
        const open = session.turnState === "open"
        if ((!open && session.exitedAt !== null) || session.metadata.archived || session.metadata.removed) return
        if (restarting.has(id)) return
        const routed = yield* live(session).pipe(Effect.option)
        if (Option.isNone(routed)) {
          yield* collectResult(undefined, session)
          return yield* live(session)
        }
        const h = routed.value
        const terminal = session.address
        const r = yield* track(id)
        const maybe = yield* agentState(h, terminal).pipe(Effect.option)
        if (Option.isNone(maybe)) return
        const seen = maybe.value
        const state = stateOf(seen) === "unknown" ? undefined : stateOf(seen)
        if (state !== undefined && session.status !== state) yield* db.updateSession(session.id, { status: state })
        if (state === "working" || state === "blocked") yield* Ref.set(r.sawWorking, true)
        if ((yield* collectResult(h, session)) !== "none") return
        if (state === undefined) {
          const terminalRunning = yield* alive(h, terminal)
          const reportedPid = session.metadata.pid
          const harnessGone =
            terminalRunning && typeof reportedPid === "number" && (yield* processes.liveness(reportedPid)) === "exited"
          if (harnessGone || !terminalRunning) {
            const cutOff = session.startedAt === null
            if (open && !cutOff)
              yield* finish(session, "failed", "", "the session exited (its terminal is gone or its process with it)")
            if (session.exitedAt === null) {
              yield* db.updateSession(id, {
                status: "unknown",
                exitedAt: yield* Clock.currentTimeMillis,
                ...(cutOff ? { end: "launch_failed" as const } : {}),
              })
              yield* recount(session.runtime, session.projectId).pipe(Effect.ignore)
            }
            if (cutOff) yield* undoCutOffStart(h, session)
            yield* dropQueue(session, `${id} exited before it was delivered; send it again to resume the session`)
            return
          }
          if (!(yield* Ref.getAndSet(r.launchRechecked, true)))
            yield* engine.arm(`launch:${id}`, START_TIMEOUT, checkLocked(id))
        } else yield* Ref.set(r.launchRechecked, false)
        if (!harnesses.get(session.harnessId).ownSessionId && h.session !== undefined) {
          const sessionId = yield* h.session(terminal).pipe(Effect.catch(() => Effect.succeed(null)))
          if (sessionId !== null && sessionId !== session.harnessSessionId)
            yield* db.updateSession(id, { harnessSessionId: sessionId })
        }

        const s = state ?? "unknown"
        if (s !== "working" && s !== "blocked" && session.startedAt !== null) {
          const task = yield* db.untakenTask(id)
          if (task !== undefined) return yield* handTask(h, session, terminal, task)
        }
        if (!open) {
          if (s !== "working" && s !== "blocked") yield* deliverQueued(h, session, terminal)
          return
        }
        if (s === "blocked") {
          if (!(yield* Ref.getAndSet(r.blockedNotified, true))) {
            const since = new Date(yield* Clock.currentTimeMillis)
            const hhmm = [since.getHours(), since.getMinutes()].map((n) => String(n).padStart(2, "0")).join(":")
            yield* notice(
              session,
              `${shortId(id)} (${session.harnessId}) has been waiting for a permission decision since ${hhmm}. Run vibest peek ${shortId(id)} to see the request.`,
            )
          }
          return
        }
        yield* Ref.set(r.blockedNotified, false)
        const worked = (yield* Ref.get(r.sawWorking)) || (yield* db.turnTaken(id))
        const idle = s === "idle"
        const ended = idle && worked
        const now = yield* Clock.currentTimeMillis
        const unconfirmed = Duration.toMillis(CONFIRM_TIMEOUT) - (now - session.turnPromptedAt)
        if (idle && !ended && unconfirmed <= 0) {
          yield* db.updateSession(id, { turnState: "not_started", lastActive: now })
          yield* notice(
            session,
            `task_not_started: vibest did not see ${id} start the turn it was sent (if it starts it late, that turn's result is not collected); it is idle and takes queued messages again.`,
          )
          return yield* deliverQueued(h, { ...session, turnState: "not_started" }, terminal)
        }
        if (idle && !ended) yield* engine.arm(`miss:${id}`, Duration.millis(unconfirmed), checkLocked(id))
        if (!ended) return yield* Ref.set(r.endedAt, undefined)
        const endedAt = yield* Ref.updateAndGet(r.endedAt, (e) => e ?? now)
        const grace = Duration.toMillis(HOOK_GRACE) - (now - endedAt!)
        if (grace > 0) return yield* engine.arm(`grace:${id}`, Duration.millis(grace), checkLocked(id))
        yield* Effect.logInfo(`lost ${id}: terminal tail\n${yield* paneTail(h, terminal)}`)
        yield* finish(
          session,
          "lost",
          "",
          `the turn ended without a report: the harness stopped without firing its turn-end hook (an error it has no hook for, such as a usage limit?); ${peekHint(id)}`,
        )
      })

      const checkLocked = (id: string): Effect.Effect<void> =>
        locked(id)(check(id)).pipe(logged(`check ${id}`), Effect.provideContext(platform))

      const unreachable = (session: SessionRow) => (e: { readonly message: string }) =>
        Effect.fail(new RuntimeUnreachable({ session: session.runtime, message: e.message }))

      const getRow = (id: string) =>
        db
          .getSession(id)
          .pipe(
            Effect.flatMap((session) =>
              session ? Effect.succeed(session) : Effect.fail(new NoSuchSession({ id, message: `no session ${id}` })),
            ),
          )

      const deliver = Effect.fn("Sessions.deliver")(function* (id: string) {
        const session = yield* getRow(id)
        if (session.metadata.archived || session.metadata.removed)
          return yield* new NoSuchSession({ id, message: `${id} was archived; run a new session` })
        if (
          session.turnState === "open" ||
          session.status === "blocked" ||
          (session.startedAt === null && session.exitedAt === null) ||
          restarting.has(id)
        )
          return
        const h = yield* live(session)
        const terminal = session.address
        const seen = yield* agentState(h, terminal)
        const state = stateOf(seen) === "unknown" ? undefined : stateOf(seen)
        if (state !== undefined && busy(state)) return
        if (state === undefined && !(yield* alive(h, terminal))) {
          if (session.exitedAt !== null && (yield* db.pendingInbox(id)).length === 0) return
          if (!harnesses.get(session.harnessId).ownSessionId && !session.harnessSessionId)
            return yield* new NoSuchSession({
              id,
              message: `${id} exited before the runtime reported its session id; spawn a new session`,
            })
          yield* resume(h, session)
        }
        const fresh = (yield* db.getSession(id)) ?? session
        yield* deliverQueued(h, fresh, fresh.address)
      })

      const send = (id: string, message: string, request?: string) =>
        Effect.gen(function* () {
          const session = yield* getRow(id)
          if (request !== undefined && (yield* db.queuedBy(id, request))) return
          const worktree = yield* worktreeOf(session)
          if (session.metadata.archived || session.metadata.removed || !(yield* fs.exists(worktree).pipe(Effect.orDie)))
            return yield* new NoSuchSession({ id, message: `${id} was archived; run a new session` })
          const row = yield* db.insertSend(id, message, request)
          if (!row) return yield* new NoSuchSession({ id, message: `${id} was archived; run a new session` })
        })

      const queued = (id: string, inboxId: number | undefined) =>
        Effect.gen(function* () {
          const row = (yield* db.pendingInbox(id)).find((r) => r.id === inboxId)
          if (row === undefined) return
          const failed = (cause: Cause.Cause<unknown>) =>
            Effect.gen(function* () {
              const transient = Cause.findErrorOption(cause).pipe(
                Option.exists(
                  (e) =>
                    Predicate.isTagged(e, "RuntimeUnreachable") ||
                    (e instanceof RuntimeError && (e.code === "unreachable" || e.code === "busy")),
                ),
              )
              if (
                Cause.hasInterruptsOnly(cause) ||
                transient ||
                !(yield* db.pendingInbox(id)).some((r) => r.id === row.id)
              )
                return
              const session = yield* db.getSession(id)
              if (session !== undefined) yield* undelivered(session, [row], errorMessage(cause))
            })
          yield* locked(id)(deliver(id).pipe(Effect.catchCause(failed)))
        }).pipe(logged(`send ${id}`), Effect.provideContext(platform))

      const deliverNext = (id: string) =>
        locked(id)(
          db.pendingInbox(id).pipe(Effect.flatMap((pending) => (pending.length === 0 ? Effect.void : deliver(id)))),
        ).pipe(logged(`deliver ${id}`), Effect.provideContext(platform))

      const interrupt = (id: string) =>
        getRow(id).pipe(
          Effect.flatMap((known) =>
            locked(id)(
              Effect.gen(function* () {
                const session = yield* getRow(id)
                const h = yield* live(session)
                const terminal = session.address
                const collected = yield* collectResult(h, session)
                if (collected === "delivered")
                  return { message: `${id} had already finished its turn; its result is delivered` }
                const state = stateOf(yield* agentState(h, terminal))
                const runtimeKnows = state !== undefined && state !== "unknown"
                if (runtimeKnows ? !busy(state) : session.turnState !== "open")
                  return { message: `${id} is not working; nothing to interrupt` }
                if (!(yield* interruptAgent(h, session, terminal)))
                  return yield* new SessionBusy({
                    id,
                    message: `${id} did not stop within ${Duration.format(STOP_WAIT)}; it may still be working`,
                  })
                yield* db.closeTurn(id, "interrupted", {
                  lastActive: yield* Clock.currentTimeMillis,
                  ...(runtimeKnows ? {} : { status: "idle" as const }),
                })
                return { message: `${id} interrupted; its terminal, worktree and session are kept` }
              }),
            ).pipe(Effect.catchTags({ RuntimeError: unreachable(known), PlatformError: Effect.die })),
          ),
          Effect.provideContext(platform),
        )

      const peek = (id: string, lines: number) =>
        Effect.gen(function* () {
          const session = yield* getRow(id)
          if (session.exitedAt !== null || session.address.id === "")
            return yield* new NoSuchSession({
              id,
              message: `${id} has no terminal to peek at (it exited or never started)`,
            })
          const h = yield* live(session)
          const text = yield* h
            .read(session.address, Math.max(1, Math.min(Math.floor(lines), 500)))
            .pipe(Effect.catchTag("RuntimeError", unreachable(session)))
          return text.trimEnd()
        })

      const removeLocked = (
        id: string,
        options: { readonly keepWorktree?: boolean | undefined; readonly unlessPending?: boolean },
      ) =>
        Effect.gen(function* () {
          let session = yield* getRow(id)
          const h = yield* live(session)
          const terminal = session.address
          const seen = yield* agentState(h, terminal)
          const reasons: Array<string> = []
          const working = busyOf(seen)
          if (working || session.turnState === "open") {
            if (options.unlessPending) return undefined
            if (working) {
              const stopped = yield* interruptAgent(h, session, terminal)
              reasons.push(
                stopped
                  ? `${id} was working: interrupted, then its terminal closed`
                  : `${id} did not stop within ${Duration.format(STOP_WAIT)} of the interrupt key; its terminal closed anyway`,
              )
            }
            if (session.turnState === "open") {
              yield* db.closeTurn(id, "interrupted", { lastActive: yield* Clock.currentTimeMillis })
            }
            session = yield* getRow(id)
          }
          if (!(session.metadata.archived || session.metadata.removed)) {
            if (options.unlessPending) {
              if (!(yield* db.archiveIfNoPending(id))) return undefined
            } else {
              yield* db.updateSession(id, {
                metadata: { ...session.metadata, archived: true, removed: true },
                lastActive: yield* Clock.currentTimeMillis,
              })
              yield* dropQueue(session, `${id} was archived before it was delivered`)
            }
            session = yield* getRow(id)
          }
          const out = yield* locks.withLock(directoryLock((yield* db.sessionDirectory(id)) ?? ""))(
            removal.release({
              h,
              session,
              terminal: session.exitedAt === null ? terminal : undefined,
              keepWorktree: options.keepWorktree,
              reasons,
            }),
          )
          yield* recount(session.runtime, session.projectId).pipe(Effect.ignore)
          return out
        })

      const remove = (id: string, options: { readonly keepWorktree?: boolean | undefined } = {}) =>
        Effect.gen(function* () {
          yield* getRow(id)
          const { r, already } = yield* stop(id)
          if (already) return yield* new SessionBusy({ id, message: `${id} is already being removed` })
          const out = (yield* locked(id)(removeLocked(id, options)).pipe(
            Effect.ensuring(Ref.set(r.stopping, false).pipe(Effect.andThen(Effect.forkIn(forget(id), scope)))),
          ))!
          return out
        }).pipe(
          Effect.catchTag("PlatformError", () => Effect.die(new Error("a platform error blocked a remove"))),
          Effect.provideContext(platform),
        )

      const archiveDelivered = (row: InboxRow) =>
        Effect.gen(function* () {
          if (row.kind !== "result") return
          const id = row.sessionId
          const owner = yield* db.getSession(id)
          if (!owner?.metadata.archive || owner.metadata.archived || owner.metadata.removed) return
          if (row.details.status !== "completed") return
          yield* locked(
            id,
            true,
          )(
            Effect.gen(function* () {
              const r = yield* track(id)
              if (yield* Ref.getAndSet(r.stopping, true)) return
              yield* Effect.gen(function* () {
                const session = yield* getRow(id)
                if (session.metadata.archived || session.metadata.removed) return
                const skip = (why: string) =>
                  notice(session, `${id} not archived (vibest run --archive-on-completion): ${why}`)
                const latest = yield* db.latestInbox(id, "result")
                if (
                  session.turnState !== "completed" ||
                  latest?.status !== "delivered" ||
                  latest.details.status !== "completed"
                )
                  return
                const h = yield* live(session)
                const terminal = session.address
                const seen = yield* agentState(h, terminal)
                if (seen === "absent")
                  return yield* skip(
                    `its harness already exited, so vibest cannot prove its processes are gone; run vibest archive ${id} when you are done with it`,
                  )
                const settled = yield* settleAfterInterrupt(h, session, terminal)
                if (!settled)
                  return yield* skip(
                    `it did not go idle within ${Duration.format(STOP_WAIT)}; run vibest archive ${id}`,
                  )
                const out = yield* removeLocked(id, { unlessPending: true })
                if (!out) return
                const kept = out.reasons.length > 0 ? ` Kept because: ${out.reasons.join("; ")}.` : ""
                const again = out.processes === "exited" ? "" : ` Run vibest archive ${id} again to check.`
                if (kept || again)
                  yield* notice(
                    session,
                    `${id} archived (vibest run --archive-on-completion): terminal ${out.pane}, worktree ${out.worktree} at ${out.path}, branch ${out.branch ?? "(none)"} kept.${kept}${again}`,
                  )
              }).pipe(
                Effect.catchCause((cause) =>
                  Cause.hasInterruptsOnly(cause)
                    ? Effect.failCause(cause)
                    : getRow(id).pipe(
                        Effect.flatMap((session) =>
                          notice(
                            session,
                            `${id} auto-archive failed: ${errorMessage(cause)}; run vibest archive ${id}`,
                          ),
                        ),
                      ),
                ),
                Effect.ensuring(Ref.set(r.stopping, false).pipe(Effect.andThen(Effect.forkIn(forget(id), scope)))),
              )
            }),
          )
        })

      const view = (session: SessionRow) =>
        session.agent === "main"
          ? Effect.succeed({
              ...session,
              worktree: "",
              repositoryRoot: undefined,
              git: undefined,
            } satisfies SessionView)
          : Effect.gen(function* () {
              const worktree = yield* worktreeOf(session)
              const repos = yield* workspaceGit(worktree).pipe(Effect.orDie)
              if (repos) {
                const unsaved = repos.find((r) => !r.saved)
                const git: GitState = {
                  branch: repos.map((r) => `${r.name}=${r.branch}`).join("\n"),
                  pushed: repos.every((r) => r.pushed),
                  saved: repos.every((r) => r.saved),
                  why: unsaved ? `${unsaved.name}: ${unsaved.why}` : "",
                }
                const repositoryRoot = (yield* projectRoot(worktree).pipe(Effect.orDie)).root
                return { ...session, worktree, repositoryRoot, git } satisfies SessionView
              }
              const g = yield* gitState(worktree).pipe(Effect.orDie)
              const repositoryRoot = g
                ? yield* mainCheckout(worktree).pipe(Effect.option, Effect.map(Option.getOrUndefined))
                : undefined
              return { ...session, worktree, repositoryRoot, git: g } satisfies SessionView
            })

      const unlocated = (session: SessionRow): SessionView => ({
        ...session,
        worktree: "",
        repositoryRoot: undefined,
        git: undefined,
      })

      const get = (id: string) => getRow(id).pipe(Effect.flatMap(view), Effect.provideContext(platform))
      const list = (filter: { projectId?: string; stopped?: boolean } = {}) =>
        db.listSessions(filter).pipe(
          Effect.flatMap((rows) =>
            Effect.forEach(rows, (row) =>
              view(row).pipe(Effect.catchTag("NoSuchSession", () => Effect.succeed(unlocated(row)))),
            ),
          ),
          Effect.provideContext(platform),
        )

      const onTerminal = (terminal: Terminal, working: boolean) =>
        Effect.gen(function* () {
          const id = yield* sessionAt(terminal)
          if (id === undefined) return
          if (working) yield* Ref.set((yield* track(id)).sawWorking, true)
          yield* checkLocked(id)
        })

      const turnStarted = (id: string, at: number) =>
        Effect.gen(function* () {
          const session = yield* db.getSession(id)
          if (session?.turnState === "open" && at >= session.turnPromptedAt) yield* sawTurnStart(id)
        })

      const handle = (event: EngineEvent): Effect.Effect<void> => {
        switch (event.type) {
          case "turn.reported":
            return resultReady(event.sessionId)
          case "turn.end":
            return deliverNext(event.sessionId)
          case "inbox.queued":
            return queued(event.sessionId, event.inboxId)
          case "live.state":
            return onTerminal(event.terminal, event.state === "working")
          case "live.exited":
            return onTerminal(event.terminal, false)
          case "process.end":
            return forget(event.sessionId)
          case "live.reset":
            return republish().pipe(
              Effect.andThen(reconcile({ runtime: event.runtime, machine: event.machine })),
              Effect.provideContext(platform),
            )
          case "live.turn_start":
            return turnStarted(event.sessionId, event.at)
          default:
            return Effect.void
        }
      }

      const finishArchive = (id: string) =>
        locked(id)(
          Effect.gen(function* () {
            const session = yield* getRow(id)
            if (!(session.metadata.archived || session.metadata.removed) || session.exitedAt !== null) return
            const h = yield* live(session)
            const out = yield* locks.withLock(directoryLock((yield* db.sessionDirectory(id)) ?? ""))(
              removal.release({ h, session, terminal: session.address, keepWorktree: true, reasons: [] }),
            )
            yield* recount(session.runtime, session.projectId).pipe(Effect.ignore)
            if (out.processes !== "exited")
              yield* notice(
                session,
                `${id} was being archived when vibestd stopped: its terminal was ${out.pane === "kept" ? "not closed" : "closed"}, but its processes are ${out.processes === "alive" ? "still working in its worktree" : "not confirmed gone"}; run vibest archive ${id} again to check.`,
              )
          }),
        ).pipe(logged(`archive ${id}`), Effect.provideContext(platform))

      const reconcile = (where: "all" | { readonly runtime: string; readonly machine?: string }) =>
        Effect.gen(function* () {
          const here = (yield* db.listSessions()).filter(
            (row) =>
              where === "all" ||
              (row.runtime === where.runtime && (where.machine === undefined || row.address.machine === where.machine)),
          )
          const rows = here.filter(
            (row) =>
              !row.metadata.archived && !row.metadata.removed && (row.exitedAt === null || row.turnState === "open"),
          )
          const archiving = here.filter(
            (row) => (row.metadata.archived || row.metadata.removed) && row.exitedAt === null && row.address.id !== "",
          )
          yield* Effect.forEach(archiving, (row) => finishArchive(row.id), { concurrency: 8, discard: true })
          yield* Effect.log(
            `reconcile ${where === "all" ? "all" : `${where.runtime}${where.machine ? ` on ${where.machine}` : ""}`}: ${rows.length} live sessions`,
          )
          yield* Effect.forEach(rows, (row) => checkLocked(row.id), { concurrency: 8, discard: true })
          yield* Effect.forEach(
            rows.filter((row) => row.metadata.archive),
            (row) =>
              Effect.all([db.latestInbox(row.id, "result"), live(row).pipe(Effect.option)]).pipe(
                Effect.flatMap(([latest, routed]) =>
                  latest === undefined || Option.isNone(routed) ? Effect.void : archiveDelivered(latest),
                ),
                logged(`archive ${row.id}`),
                Effect.provideContext(platform),
              ),
            { concurrency: 8, discard: true },
          )
          for (const project of yield* db.pendingProjects) yield* inbox.deliver(project)
        })

      yield* Effect.forkIn(
        inbox.delivered.pipe(
          Effect.flatMap(({ row, done }) =>
            Effect.forkIn(
              archiveDelivered(row).pipe(
                Effect.ensuring(done),
                logged(`archive ${row.sessionId}`),
                Effect.provideContext(platform),
              ),
              scope,
            ),
          ),
          Effect.forever,
        ),
        scope,
      )

      const resultReady = (id: string) =>
        Effect.forkIn(
          locked(id, true)(check(id)).pipe(logged(`check ${id}`), Effect.provideContext(platform)),
          scope,
        ).pipe(Effect.asVoid)

      const vibestCommand = yield* VibestCommand
      const { outdated, restart, restartLater } = sessionRestart({
        db,
        bus,
        runtimes,
        harnesses,
        processes,
        restarting,
        inbox,
        scope,
        locked: (id) => locked(id),
        checkLater: (id) => Effect.forkIn(checkLocked(id), scope).pipe(Effect.asVoid),
        launchArgv: (session, resume) => launchArgv(session, resume).pipe(Effect.provideContext(platform)),
        mainArgv: (main) =>
          Effect.gen(function* () {
            yield* db.patchLive(main.id, { ready: null })
            const root = main.projectDirectory ?? (yield* db.projectDirectory(main.projectId)) ?? ""
            const command = yield* coordinatorCommand({
              harness: main.harnessId,
              root,
              provider: main.provider,
              model: main.model,
              session: Effect.succeed({
                sessionId: main.id,
                harnessSessionId: main.harnessSessionId,
                projectId: main.projectId,
                ...(main.runtime && main.address ? { runtime: runtimeEnv(main.runtime, main.address) } : {}),
              }),
            })
            return restartArgv(command)
          }).pipe(
            Effect.provideService(Harness, harness),
            Effect.provideService(Harnesses, harnesses),
            Effect.provideService(Layout, layout),
            Effect.provideService(VibestCommand, vibestCommand),
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
          ),
        worktreeOf,
        withPlatform: (effect) => effect.pipe(Effect.provideContext(platform)),
        awaitReady,
        prompt: (h, session, terminal, text) =>
          prompt(h, session, terminal, text).pipe(Effect.provideContext(platform)),
      })

      yield* engine.on(handle)

      yield* db.recoverDelivering(
        harnesses.all.filter((h) => h.inbox === "poll").map((h) => h.id),
        (sessionId, messages) =>
          `A message to ${sessionId} was not delivered: vibestd stopped while handing it to the session; it may or may not have arrived\n\n${messages.join("\n\n")}`,
      )
      yield* republish()
      yield* Effect.forkIn(reconcile("all").pipe(logged("reconcile")), scope)

      return Sessions.of({
        spawn,
        send,
        interrupt,
        peek,
        remove,
        get,
        list,
        check: checkLocked,
        userPrompt: (id: string, text: string, at?: number) =>
          Effect.gen(function* () {
            const now = at ?? (yield* Clock.currentTimeMillis)
            yield* bus.observe({ type: "live.turn_start", sessionId: id, at: now })
            yield* userPrompt(id, text, now)
            yield* db.markWorking(id)
          }),
        republish: republish().pipe(Effect.provideContext(platform)),
        inMemory: Effect.gen(function* () {
          const map = yield* SynchronizedRef.get(tracked)
          return { tracked: HashMap.size(map), locks: locks.size() }
        }),
        outdated,
        restart,
        restartLater,
      })
    })

  static readonly layer = Layer.effect(
    Sessions,
    Config.option(Config.Int("VIBEST_MAX_SESSIONS")).pipe(
      Effect.flatMap((max) => Sessions.make({ maxSessions: Option.getOrUndefined(max) })),
    ),
  )
}
