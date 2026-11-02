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
// Session state machine (SPEC §8, §9). Every operation on one session runs under that session's lock;
// different sessions proceed in parallel. A session is addressed by its row's terminal — `runtime { kind }` routes the
// call to the registered Runtime (runtime-port.md §3), `address { machine, id }` names the terminal in it. Core follows
// each Agent with the runtime's `state` and `events` when they exist, else by polling (§5), and a turn ends when the
// agent goes idle after working or its process exits; the result is the integration's report (the result file).
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
  Fiber,
  FileSystem,
  HashMap,
  Layer,
  Option,
  Path,
  PlatformError,
  Predicate,
  Ref,
  Schedule,
  Semaphore,
  Stream,
  SynchronizedRef,
} from "effect"
import type { Scope } from "effect"
import { Hex } from "effect/encoding"
import { ChildProcessSpawner } from "effect/process"

import { Db, type InboxRow, type SessionRow } from "./db.ts"
import { Drain } from "./drain.ts"
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
import { limitMoveBox, sessionMove } from "./move.ts"
import {
  ALLOCATION_LEAF,
  ALLOCATION_NAME_ATTEMPTS,
  allocationLeafTaken,
  Layout,
  VibestCommand,
  resolveWorktree,
  safeRepositoryDirectory,
  worktreePath,
} from "./paths.ts"
import { sessionPlacement } from "./placement.ts"
import { describeSpawn, errorMessage, Plugins, type Routing } from "./plugins.ts"
import { listProjectRepositories, projectRoot, workspaceGit } from "./project-create.ts"
import * as Remove from "./remove.ts"
import { readReportLines } from "./results.ts"
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
  type RuntimeEvent,
  stateOf,
  type Terminal,
  type AgentSeen,
} from "./runtimes.ts"
import { Subscriptions } from "./subscriptions/service.ts"
import {
  allocationParentBlocked,
  entryTaken,
  gitState,
  type GitState,
  mainCheckout,
  repositoryDirectoryName,
} from "./worktree.ts"
/**
 * VIBEST_RUNTIME (and the vibest-runtime header): where an agent runs, `{runtime, machine, terminal}` as vibestd recorded
 * it. Opaque to agents and integrations: they pass it on, and only the runtime plugin reads it.
 */
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

/** Test barrier after `--peer` validation and before insert, while the owner's session lock is held. Production leaves this void. */
export const peerAdmitPause: { wait: Effect.Effect<void> } = { wait: Effect.void }
/** Test seam: try these 4-hex leaves in order instead of random draws. Unset in production. */
export const allocationNameSource: { leaves: ReadonlyArray<string> | undefined } = { leaves: undefined }

export const START_TIMEOUT = Duration.seconds(120)
export const READY_TIMEOUT = Duration.seconds(60)
export const CONFIRM_TIMEOUT = Duration.seconds(8)
export const HOOK_GRACE = Duration.seconds(10)
export const TAIL_LINES = 30
export const POLL = Duration.seconds(5)
export const STOP_WAIT = Duration.seconds(10)
const TICK = Schedule.spaced("500 millis")

type Platform = FileSystem.FileSystem | Path.Path | Crypto.Crypto | ChildProcessSpawner.ChildProcessSpawner

/** In-memory only; rebuilt from sqlite and the runtime after a restart. Dropped once the session has ended (`forget`). */
interface Tracked {
  /** When the open turn was last seen working: a state, an event, or a turn-start report line (its file is the durable proof). */
  readonly sawWorking: Ref.Ref<boolean>
  readonly endedAt: Ref.Ref<number | undefined>
  readonly blockedNotified: Ref.Ref<boolean>
  /** True while core is sending the prompt text. The hook that fires then is the paste's echo, not a typed round. */
  readonly prompting: Ref.Ref<boolean>
  readonly stopping: Ref.Ref<boolean>
  /** Check command in flight for one result mtime. The attempt count lives on the session row. */
  readonly checking: Ref.Ref<
    { readonly mtime: number; readonly fiber: Fiber.Fiber<void>; readonly token: number } | undefined
  >
  /** A continuation paste is in flight. Its wait does not hold the session lock, so a second check must not paste too. */
  readonly pasting: Ref.Ref<boolean>
}

const newTracked: Effect.Effect<Tracked> = Effect.all({
  sawWorking: Ref.make(false),
  endedAt: Ref.make<number | undefined>(undefined),
  blockedNotified: Ref.make(false),
  prompting: Ref.make(false),
  stopping: Ref.make(false),
  checking: Ref.make<{ readonly mtime: number; readonly fiber: Fiber.Fiber<void>; readonly token: number } | undefined>(
    undefined,
  ),
  pasting: Ref.make(false),
})

export interface SpawnInput {
  /** The machine the caller named: `local`, plus the runtime's own way to reach it (`Machine.target`). */
  readonly machine: Machine
  /** The main checkout (`mainCheckout`): worktrees are created only from it. */
  readonly root: string
  /** The project key of `root` (`projectRoot(root).key`), computed once by the caller: the row, the scratch directory and the rules all use it. */
  readonly key: string
  readonly name: string
  readonly prompt: string
  /** Optional when a plugin picks it (plugins.md §5). */
  readonly harness?: HarnessId | undefined
  readonly provider?: string | undefined
  readonly model?: string | undefined
  readonly env?: Record<string, string> | undefined
  /** `coordinator` and `main` are refused by the Spawn RPC; anything else is stored, default `general`. */
  readonly agent?: string | undefined
  /** Run in this session's worktree, in a terminal beside its own, instead of a new worktree (`vibest run --peer`). */
  readonly peer?: string | undefined
  /** Archive it once a completed result reached the coordinator (`vibest run --archive-on-completion`). */
  readonly archive?: boolean | undefined
  /** The session that asked for it (the main agent); undefined for the user's own `vibest run`. */
  readonly parentSessionId?: string | undefined
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
    /** Queue a message; vibestd delivers it once the session is idle (SPEC §8.4). Returns once the message is stored. */
    readonly send: (id: string, message: string) => Effect.Effect<void, NoSuchSession>
    /** Interrupt the running turn and keep the session (terminal, worktree, conversation) for follow-ups (SPEC §8.6). */
    readonly interrupt: (
      id: string,
    ) => Effect.Effect<{ message: string }, NoRuntime | NoSuchSession | SessionBusy | RuntimeUnreachable>
    /** Close a session's terminal and remove its worktree when git agrees (SPEC §8.6a). The row stays. */
    readonly remove: (
      id: string,
      options?: { readonly keepWorktree?: boolean | undefined },
    ) => Effect.Effect<
      Remove.RemoveOutcome | undefined,
      NoRuntime | NoSuchSession | SessionBusy | RuntimeUnreachable | RuntimeError
    >
    readonly get: (id: string) => Effect.Effect<SessionView, NoSuchSession>
    /** The last `lines` lines on the session's terminal (`vibest peek`), read on demand; never sent to an agent. */
    readonly peek: (id: string, lines: number) => Effect.Effect<string, NoSuchSession | NoRuntime | RuntimeUnreachable>
    readonly list: (filter?: { projectId?: number; stopped?: boolean }) => Effect.Effect<ReadonlyArray<SessionView>>
    /** One evaluation of SPEC §8.5 for a session; also what events and the poll trigger. */
    readonly check: (id: string) => Effect.Effect<void>
    /** RPC `ResultReady` from a hook: schedule a check and return at once (SPEC §7, §9). */
    readonly resultReady: (id: string) => Effect.Effect<void>
    /** RPC `Prompt`: the user typed into a subagent's terminal; with no round open, that opens one. */
    readonly userPrompt: (id: string, text: string) => Effect.Effect<void, never, FileSystem.FileSystem>
    /** Terminal and workspace labels again, after the runtime dropped them. How many terminals were labelled. */
    readonly republish: Effect.Effect<number>
    /** Entries vibestd keeps in memory for sessions (vibestd-state.md 5): tests check they shrink back once sessions end. */
    readonly inMemory: Effect.Effect<{ readonly tracked: number; readonly locks: number }>
  }
>()("vibest/Sessions") {
  /** `maxSessions`: non-stopped sessions on this machine; undefined = no limit. */
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
      const platform = yield* Effect.context<Platform>()
      const scope = yield* Effect.scope

      const tracked = yield* SynchronizedRef.make(HashMap.empty<string, Tracked>())
      const allocating = yield* Semaphore.make(1)
      const track = (id: string) =>
        SynchronizedRef.modifyEffect(tracked, (map) =>
          Option.match(HashMap.get(map, id), {
            onSome: (r) => Effect.succeed([r, map] as const),
            onNone: () => newTracked.pipe(Effect.map((r) => [r, HashMap.set(map, id, r)] as const)),
          }),
        )
      const locks = keyedLock<string>()
      /** Set the session's `stopping` flag in the same step as the lookup, so `sweep` cannot drop the flags in between. Whether it was set already. */
      const stop = (id: string) =>
        SynchronizedRef.modifyEffect(tracked, (map) =>
          Effect.gen(function* () {
            const r = Option.getOrUndefined(HashMap.get(map, id)) ?? (yield* newTracked)
            const already = yield* Ref.getAndSet(r.stopping, true)
            return [{ r, already }, HashMap.set(map, id, r)] as const
          }),
        )
      /**
       * Once per poll (vibestd-state.md 5): drop the flags of every session that is no longer live (exited, archived, gone)
       * while nobody holds or waits on its lock and nothing is in flight on them. A live row keeps its flags; what they
       * guard starts afresh at the next prompt, as after a restart. The rows are read under the map's lock: a resume that
       * clears `exitedAt` after the read holds the session's lock (busy) or waits here in `track`.
       */
      const sweep = SynchronizedRef.updateEffect(tracked, (map) =>
        Effect.gen(function* () {
          const live = new Set(
            (yield* db.listSessions())
              .filter((row) => !row.metadata.archived && !row.metadata.removed)
              .map((row) => row.id),
          )
          let next = map
          for (const [id, r] of map) {
            if (live.has(id) || locks.busy(id)) continue
            const inFlight =
              (yield* Ref.get(r.stopping)) ||
              (yield* Ref.get(r.prompting)) ||
              (yield* Ref.get(r.pasting)) ||
              (yield* Ref.get(r.checking)) !== undefined
            if (!inFlight) next = HashMap.remove(next, id)
          }
          return next
        }),
      )
      const locked =
        (id: string, settlement = false) =>
        <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          drain.work(`session ${id}`, locks.withLock(id)(effect), settlement)
      const logged =
        (what: string) =>
        <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          effect.pipe(Effect.catchCause((cause) => Effect.logWarning(`${what}: ${Cause.pretty(cause)}`)))

      /** Which session a terminal belongs to, from the rows (the terminal is on the row now). */
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

      /** The owner's recorded directory. A peer loads its owner's row; a missing or unsafe one fails, with no second candidate. */
      const worktreeOf = (session: SessionRow) =>
        resolveWorktree(layout, session, (id) => db.getSession(id)).pipe(
          Effect.flatMap((located) =>
            located._tag === "Resolved"
              ? Effect.succeed(located.path)
              : Effect.fail(new NoSuchSession({ id: session.id, message: located.message })),
          ),
        )

      /** Fail these queued messages for good and tell the coordinator which ones, with the text so it can send them again. */
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

      /** The session is gone for now: what is still queued for it fails with `reason` (a later Send resumes it). */
      const dropQueue = (session: SessionRow, reason: string) =>
        db
          .pendingInbox(session.id)
          .pipe(Effect.flatMap((rows) => (rows.length === 0 ? Effect.void : undelivered(session, rows, reason))))

      // ---- runtime helpers (runtime-port.md §3, §5) ----

      /** The runtime a row's `runtime.kind` routes to; `NoRuntime` when no loaded plugin registered it. */
      const live = (session: SessionRow) => runtimes.route(session.runtime)

      /** Ready for input (§5): the runtime's `state` says idle, working or blocked; while it is `unknown` or `absent` (a
       * harness still starting, or showing a startup dialog such as Claude's folder trust) the harness's startup step
       * answers what it can (SPEC §8.2 step 5). A runtime without `state` is ready when `open` returned. */
      const settled = (seen: AgentSeen) => seen !== "absent" && seen !== "unknown"
      const awaitReady = (h: Runtime, terminal: Terminal, adapter: HarnessAdapter, id: string) =>
        Effect.gen(function* () {
          if (h.state === undefined) return "unknown" as AgentState
          const step = adapter.startup ? yield* adapter.startup : undefined
          const screen = h.read(terminal, 40).pipe(Effect.orElseSucceed(() => ""))
          return yield* agentState(h, terminal).pipe(
            Effect.flatMap((seen) => {
              if (settled(seen) || step === undefined) return Effect.succeed(seen)
              // The runtime cannot tell yet (a startup dialog): answer it with the harness's own step.
              return step({
                screen,
                sendKeys: (keys) => h.send(terminal, { keys: [...keys] }).pipe(Effect.ignore),
              }).pipe(Effect.as(seen))
            }),
            Effect.repeat({ until: settled, schedule: TICK }),
            Effect.timeoutOrElse({
              duration: READY_TIMEOUT,
              // What the terminal showed goes to vibestd.log only; the failure says why, never the screen.
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
            Effect.map((seen) => stateOf(seen) ?? "unknown"),
          )
        })

      /** vibest's variables in the session's terminal, which the integration and `vibest` recognize it by (SPEC §8.2 step 1b). */
      // VIBEST_SCRATCH: the session's own scratch directory, the one place under projects its guard lets it use.
      // VIBEST_RUNTIME names no terminal: the one it gets is opened after this.
      const vibestEnv = (session: SessionRow, scratch: string) => ({
        VIBEST_SESSION_ID: session.id,
        VIBEST_PROJECT_ID: String(session.projectId),
        VIBEST_SCRATCH: scratch,
        VIBEST_AGENT: session.agent,
        VIBEST_HARNESS: session.harnessId,
        VIBEST_RUNTIME: runtimeEnv(session.runtime, { machine: session.address.machine, id: "" }),
        VIBEST_HOME: layout.home,
        VIBEST_COMMAND: encodeCommand(vibest),
      })

      /** The argv that starts the session's harness in a terminal (what `open` runs). */
      const launchArgv = Effect.fn("Sessions.launchArgv")(function* (
        session: SessionRow,
        resume: boolean,
        key: string,
      ) {
        const file = layout.rulesFile(session.id)
        const adapter = harnesses.get(session.harnessId)
        const pluginDir = yield* harness.plugin(adapter.id)
        // The binary first: `open` runs argv exactly (runtime-port §3), and a runtime knows the harness by it.
        return [
          adapter.binary,
          ...adapter.launchArgs({
            worktree: yield* worktreeOf(session),
            scratch: layout.scratch(key),
            rules: yield* fs.readFileString(file),
            rulesFile: file,
            provider: session.provider,
            model: session.model,
            sessionId: session.harnessSessionId,
            resume,
            pluginDir,
            vibest,
            env: vibestEnv(session, layout.scratch(key)),
          }),
        ]
      })

      /** One look (§5): the runtime reports it working or blocked, or the integration wrote a turn-start report line of this round. */
      const pickupNow = (h: Runtime, session: SessionRow, terminal: Terminal) =>
        Effect.gen(function* () {
          const r = yield* track(session.id)
          const seen = yield* agentState(h, terminal)
          const state = stateOf(seen)
          if (state === "working" || state === "blocked") {
            yield* Ref.set(r.sawWorking, true)
            yield* db.updateSession(session.id, { status: state })
            return true
          }
          // A turn-start line dated this round is the proof the report file carries across a restart (the Ref alone cannot).
          if (yield* reportStartedSince(session.id, session.turnPromptedAt)) {
            yield* Ref.set(r.sawWorking, true)
            return true
          }
          return false
        })

      /** The turn was picked up (§5), polled until CONFIRM_TIMEOUT. */
      const confirmed = (h: Runtime, session: SessionRow, terminal: Terminal) =>
        pickupNow(h, session, terminal).pipe(
          Effect.repeat({ until: (picked) => picked, schedule: TICK }),
          Effect.timeoutOrElse({ duration: CONFIRM_TIMEOUT, orElse: () => Effect.succeed(false) }),
        )

      /** A state that must not be pasted into (SPEC §8.4). */
      const busy = (state: AgentState) => state === "working" || state === "blocked"
      const busyOf = (seen: AgentSeen) => {
        const state = stateOf(seen)
        return state !== undefined && busy(state)
      }

      /** Interrupt key, then wait for the agent to settle (core polls its state; false when it did not within STOP_WAIT). Caller holds the lock. */
      const settleAfterInterrupt = (h: Runtime, terminal: Terminal) =>
        agentState(h, terminal).pipe(
          Effect.map((seen) => {
            const state = stateOf(seen)
            return state !== undefined && state !== "working" && state !== "blocked"
          }),
          Effect.repeat({ until: (idle) => idle, schedule: TICK }),
          Effect.timeoutOrElse({ duration: STOP_WAIT, orElse: () => Effect.succeed(false) }),
        )
      const interruptAgent = (h: Runtime, session: SessionRow, terminal: Terminal) =>
        Effect.gen(function* () {
          yield* h.send(terminal, { keys: [harnesses.get(session.harnessId).interruptKey] }).pipe(Effect.ignore)
          return yield* settleAfterInterrupt(h, terminal)
        })

      type Collected = "none" | "pending" | "delivered"
      // Assigned once `collectResult` exists. `prompt` runs only after `Sessions.make` finishes.
      let collectResult: (
        h: Runtime,
        session: SessionRow,
        mode?: "deliver" | "stop",
        liveState?: AgentState | undefined,
        parked?: { paste?: Effect.Effect<void, unknown, FileSystem.FileSystem> },
      ) => Effect.Effect<
        Collected,
        RuntimeError | NoSuchSession | PlatformError.PlatformError | SessionBusy,
        ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
      > = () => Effect.die("collectResult")

      /** Whether a turn-start report line of the round prompted at `at` exists: the pickup proof §5 compares, durable
       * in the report file. Every stamp is taken before its round's start line can be written (the hook sends `Prompt`
       * first; a continuation is stamped before its paste). */
      const reportStartedSince = (id: string, at: number) =>
        readReportLines(layout.reportFile(id)).pipe(
          Effect.map((lines) => lines.some((line) => line.turn === "start" && line.ts >= at)),
          Effect.orElseSucceed(() => false),
        )

      /**
       * Send a turn and confirm it started. Returns why not (no screen text: the tail goes to vibestd.log) when the session never picked it up
       * and the integration wrote no result; the caller tells the owner. A result already on disk is delivered instead, and
       * the caller hears nothing. `onHandover` runs once the session is ready, right before the runtime gets the text.
       * Caller holds the session's lock. `keepRound`: a move will try the next harness, so a miss leaves the open round
       * working; the default still closes it.
       */
      const prompt = Effect.fn("Sessions.prompt")(function* (
        h: Runtime,
        session: SessionRow,
        terminal: Terminal,
        text: string,
        onHandover: Effect.Effect<void> = Effect.void,
        options?: { readonly keepRound?: boolean },
      ) {
        // Open before ready() so a typed prompt during resume sees the round. Claim stays after ready: a session that
        // never gets ready does not take the rows. The second update binds them onto this round.
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
        // The round is open before the runtime gets the text, so the prompt hook it fires is ignored.
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
        // A miss undoes the round opened above — unless a move will try the next harness on it.
        const missed = options?.keepRound
          ? Effect.void
          : db.updateSession(session.id, { turnState: "not_started", lastActive: yield* Clock.currentTimeMillis })
        // The runtime refused the text. A result the integration wrote anyway is the turn; otherwise the round opened above is undone.
        const delivered = yield* send.pipe(
          Effect.as(false),
          Effect.catchTag("RuntimeError", (error) =>
            Effect.gen(function* () {
              if ((yield* collectResult(h, session).pipe(Effect.provideContext(platform), Effect.orDie)) !== "none")
                return true
              // The connection breaking is not a refusal (§3): the text may have arrived, so the round stays open.
              if (error.code === "unreachable") return yield* Effect.fail(error)
              yield* missed
              return yield* error
            }),
          ),
        )
        if (delivered) return undefined
        if (yield* confirmed(h, session, terminal)) return undefined
        yield* h.send(terminal, { keys: ["enter"] }).pipe(Effect.ignore)
        if (yield* confirmed(h, session, terminal)) return undefined
        // Re-paste once only, so a task never runs twice.
        yield* send.pipe(Effect.ignore)
        if (yield* confirmed(h, session, terminal)) return undefined
        if ((yield* collectResult(h, session).pipe(Effect.provideContext(platform), Effect.orDie)) !== "none")
          return undefined
        yield* Effect.logInfo(`task_not_started ${session.id}: terminal tail\n${yield* paneTail(h, terminal)}`)
        yield* missed
        return `task_not_started: ${session.id} did not start working on the message; ${peekHint(session.id)}`
      })

      // ---- turn end (rounds.ts): the round lifecycle on this service's helpers ----
      // The usage-limit move is late-wired: rounds and placement ask for it before it exists (it needs `finish`).
      const limit = limitMoveBox()
      const rounds = sessionRounds({
        db,
        inbox,
        layout,
        harnesses,
        track,
        lock: locks.withLock,
        locked,
        scope,
        plugins,
        paneTail,
        busy,
        interruptAgent,
        confirmTimeout: CONFIRM_TIMEOUT,
        stopWait: STOP_WAIT,
        worktreeOf,
        notice,
        undelivered,
        logged,
        prompt,
        limitMove: limit.move,
        pickedUp: pickupNow,
      })
      collectResult = rounds.collectResult
      const { finish, deliverQueued, userPrompt, nextCheck } = rounds

      // ---- spawn ----

      /** The first turn, once the terminal exists: the rules in the prompt where the harness reads them, else the text alone. */
      const afterOpen = (
        h: Runtime,
        session: SessionRow,
        terminal: Terminal,
        root: string,
        rules: string,
        firstPrompt: string,
      ) =>
        Effect.gen(function* () {
          // Labelled as soon as it is live (§3 `present`), the same way `resume` and `recount` relabel it.
          yield* show(h, session, terminal, root)
          const first = harnesses.get(session.harnessId).rulesInPrompt
            ? `${rules}\n\n# Task\n\n${firstPrompt}`
            : firstPrompt
          const notStarted = yield* prompt(h, session, terminal, first)
          if (notStarted) yield* notice(session, notStarted)
        })

      const { launch, resume, republish, recount, openTerminal, show, locate } = sessionPlacement({
        db,
        runtimes,
        layout,
        fs,
        path,
        vibest,
        harnesses,
        worktreeOf,
        vibestEnv,
        launchArgv,
        notice,
        prompt,
        limitMove: limit.move,
        afterOpen,
      })

      // ---- the usage-limit move (move.ts): the same session on another harness ----
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
        resultFile: layout.resultFile,
        rulesFile: layout.rulesFile,
        fs: { remove: (p, o) => fs.remove(p, o), readFileString: (p) => fs.readFileString(p) },
        uuid: crypto.randomUUIDv4.pipe(Effect.orDie),
        platform,
      })
      limit.move.rerun = move.rerun

      const newId = crypto.randomBytes(4).pipe(Effect.map(Hex.encode), Effect.orDie)

      /** The `machines[]` of `agent.start.before` (§7), via the shared helper. */
      const machinesListing = machines(
        runtimes,
        harnesses.all.map((adapter) => adapter.id),
      )

      /** §4's check after the chain: the chosen runtime is loaded and online on the machine, else the start refuses with the reason. */
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

      /**
       * The session whose worktree `vibest run --peer` shares: same project, not archived, same runtime,
       * worktree on disk in this repository. A peer's peer resolves to the worktree's owner.
       */
      const peerOf = (input: SpawnInput, id: string, runtime: string, machineId: string) =>
        Effect.gen(function* () {
          const refuse = (why: string) => new NoSuchSession({ id, message: `--peer ${id}: ${why}` })
          const p = yield* db.getSession(id)
          if (!p) return yield* refuse(`no session ${id}`)
          // Reads only: a check must not insert a project row as a side effect.
          if (p.projectId !== (yield* db.projectByKey(input.key))) return yield* refuse("it belongs to another project")
          if (p.metadata.archived || p.metadata.removed) return yield* refuse("it was archived")
          if (p.runtime !== runtime || p.address.machine !== machineId)
            return yield* refuse(
              `ineligible: it runs in ${p.runtime} on ${p.address.machine}, not ${runtime} on ${machineId}`,
            )
          const worktree = yield* worktreeOf(p).pipe(Effect.mapError((e) => refuse(e.message)))
          if (!(yield* fs.exists(worktree).pipe(Effect.orDie)))
            return yield* refuse(`ineligible: its worktree ${worktree} is gone`)
          // A multi-repository workspace is not itself a checkout; the project id above is what it belongs to.
          if (
            !(yield* listProjectRepositories(worktree).pipe(Effect.mapError((e) => refuse(e.message)))) &&
            !Option.contains(yield* mainCheckout(worktree).pipe(Effect.option), input.root)
          )
            return yield* refuse(`ineligible: its worktree is not in ${input.root}`)
          return p.metadata.peer ?? p.id
        })

      const spawn = Effect.fn("Sessions.spawn")(function* (input: SpawnInput) {
        const root = input.root
        const agent = input.agent ?? "general"
        const parent = input.parentSessionId === undefined ? undefined : yield* db.getSession(input.parentSessionId)
        // Plugins see the resolved root and route before anything is checked (architecture.md §9); the runtime choice is
        // theirs too (runtime-port.md §4): the chain gets every machine and may set `machine` and `runtime`.
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
          runtime: undefined,
          parentRuntime: parent?.runtime,
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
        // A plugin's choice that cannot run names the plugin.
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
        const id = yield* newId.pipe(
          Effect.flatMap((id) => db.sessionExists(id).pipe(Effect.map((taken) => (taken ? undefined : id)))),
          Effect.repeat({ until: (id) => id !== undefined }),
          Effect.map((id) => id!),
        )
        const now = yield* Clock.currentTimeMillis
        const admit = (peer: string | undefined) => {
          const reserve = Effect.gen(function* () {
            const refuse = (message: string) => new AllocationFailed({ message })
            const folders = yield* listProjectRepositories(root).pipe(
              Effect.mapError((e) => refuse(`${root}: ${e.message}`)),
            )
            const key = input.key
            const base = {
              ...(input.env ? { env: input.env } : {}),
              ...(Object.keys(decision.decidedBy).length > 0 ? { routing } : {}),
              ...(input.archive ? { archive: true } : {}),
            }
            let allocation: { readonly worktreeRepository: string; readonly worktreeName: string } | undefined
            if (peer === undefined) {
              // `<worktrees>/<project>/<leaf>/<repository>` for a multi-repository project; otherwise the repository's own name.
              const repository = folders
                ? path.basename(root)
                : yield* repositoryDirectoryName(root).pipe(Effect.mapError((e) => refuse(e.message)))
              if (!safeRepositoryDirectory(repository))
                return yield* refuse(
                  `repository name ${JSON.stringify(repository)} cannot be a directory under worktrees (empty, unsafe, or an 8-hex legacy session id)`,
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
              const scripted = allocationNameSource.leaves
              const attempts =
                scripted === undefined ? ALLOCATION_NAME_ATTEMPTS : Math.min(scripted.length, ALLOCATION_NAME_ATTEMPTS)
              let leaf: string | undefined
              for (let i = 0; i < attempts; i++) {
                const candidate = scripted?.[i] ?? Hex.encode(yield* crypto.randomBytes(2).pipe(Effect.orDie))
                if (!ALLOCATION_LEAF.test(candidate)) continue
                const rows = yield* db.listSessions({ stopped: true })
                const where = layout.allocationWorktree(repository, candidate)
                if (allocationLeafTaken(rows, repository, candidate, id)) continue
                if (yield* entryTaken(where).pipe(Effect.mapError((e) => refuse(`${where}: ${e.message}`)))) continue
                leaf = candidate
                break
              }
              if (leaf === undefined)
                return yield* refuse(`no unused 4-hex worktree name under ${repository} after ${attempts} attempts`)
              allocation = { worktreeRepository: repository, worktreeName: leaf }
            }
            const draft: Omit<SessionRow, "projectId"> = {
              id,
              agent,
              name: input.name,
              harnessId,
              provider: provider ?? null,
              model: model ?? null,
              harnessSessionId: adapter.ownSessionId ? yield* crypto.randomUUIDv4.pipe(Effect.orDie) : null,
              runtime: runtimeKind,
              address: { machine: machine.id, id: "" },
              status: "unknown",
              startedAt: null,
              exitedAt: null,
              turnState: "none",
              turnPromptedAt: 0,
              metadata: { ...base, ...(peer !== undefined ? { peer } : allocation!) },
              createdAt: now,
              lastActive: now,
            }
            // A peer works in its owner's directory; Db copies it from the owner row.
            const cwd = worktreePath(layout, draft) ?? ""

            if (
              !(yield* db.insertSession(draft, key, options.maxSessions, cwd, decision.prompt, input.parentSessionId))
            )
              return yield* new LimitReached({ limit: options.maxSessions! })
            return (yield* db.getSession(id))!
          })
          return peer === undefined ? allocating.withPermit(reserve) : reserve
        }
        // Archive of the owner holds this same semaphore across its sharing check and git worktree remove. Lock only that owner: also locking the named peer can cycle with another admission.
        const row =
          input.peer === undefined
            ? yield* admit(undefined)
            : yield* Effect.gen(function* () {
                const named = yield* db.getSession(input.peer!)
                if (!named) {
                  yield* peerOf(input, input.peer!, runtimeKind, decision.machine.id)
                  return yield* Effect.die("peerOf returned for a missing session")
                }
                const ownerId = named.metadata.peer ?? named.id
                return yield* locked(ownerId)(
                  Effect.gen(function* () {
                    const peer = yield* peerOf(input, input.peer!, runtimeKind, decision.machine.id)
                    if (peer !== ownerId)
                      return yield* new NoSuchSession({
                        id: input.peer!,
                        message: `--peer ${input.peer}: ineligible: its worktree owner changed`,
                      })
                    yield* peerAdmitPause.wait
                    return yield* admit(peer)
                  }),
                )
              })
        // The launch holds the lock before spawn returns, so no check sees the row as an abandoned `starting` one.
        const held = yield* Deferred.make<void>()
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const leave = drain.track(`spawn ${id}`)
            yield* Effect.forkIn(
              locks
                .withLock(id)(
                  Deferred.succeed(held, undefined).pipe(
                    Effect.andThen(launch(rt, machine, row, root, decision.prompt, input.peer)),
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

      const check = Effect.fn("Sessions.check")(function* (
        id: string,
        parked: { paste?: Effect.Effect<void, unknown, FileSystem.FileSystem> },
      ) {
        const session = yield* db.getSession(id)
        if (!session) return
        const open = session.turnState === "open"
        // An exited session is resumed by the next message (SPEC §8.4), not by a check. An archived one is vibest archive's alone.
        if ((!open && session.exitedAt !== null) || session.metadata.archived || session.metadata.removed) return
        // A delivery cut off by vibestd stopping (no delivery runs while the lock is held): it may or may not have arrived.
        const cutOff = yield* db.inboxWithStatus(id, "sending")
        if (cutOff.length > 0)
          yield* undelivered(
            session,
            cutOff,
            "vibestd stopped while handing it to the session; it may or may not have arrived",
          )
        const h = yield* live(session)
        const terminal = session.address
        const r = yield* track(id)
        const maybe = yield* agentState(h, terminal).pipe(Effect.option)
        // Unreachable is no answer: this check tries again on the next poll, the row untouched.
        if (Option.isNone(maybe)) return
        const seen = maybe.value
        // Status is the runtime's, as it reports it now. `unknown` is no answer: the process fallback decides (§5).
        const state = stateOf(seen) === "unknown" ? undefined : stateOf(seen)
        if (state !== undefined && session.status !== state) yield* db.updateSession(session.id, { status: state })
        if (state === "working" || state === "blocked") yield* Ref.set(r.sawWorking, true)
        if ((yield* collectResult(h, session, "deliver", state, parked)) !== "none") return
        if (seen === "absent" || (state === undefined && !(yield* alive(h, terminal)))) {
          if (session.startedAt === null) {
            // vibestd died mid-spawn (SPEC §5.5 spawn).
            yield* notice(session, `${id} never finished starting (vibestd restarted during spawn).`)
          } else if (open)
            yield* finish(session, "failed", "", "the session exited (its terminal is gone or its process with it)")
          // The runtime has no agent for it any more: its status is unknown, and the project workspace's live count no longer includes it.
          if (session.exitedAt === null) {
            yield* db.updateSession(id, { status: "unknown", exitedAt: yield* Clock.currentTimeMillis })
            yield* recount(session.runtime, session.projectId).pipe(Effect.ignore)
          }
          yield* dropQueue(session, `${id} exited before it was delivered; send it again to resume the session`)
          return
        }
        // A harness whose ids the runtime knows by watching it (Cursor): its record replaces a conversation id adopted from a report.
        if (!harnesses.get(session.harnessId).ownSessionId && h.session !== undefined) {
          const sessionId = yield* h.session(terminal).pipe(Effect.catch(() => Effect.succeed(null)))
          if (sessionId !== null && sessionId !== session.harnessSessionId)
            yield* db.updateSession(id, { harnessSessionId: sessionId })
        }

        const s = state ?? "unknown"
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
              `${id} (${session.harnessId}) has been waiting for a permission decision since ${hhmm}. Run vibest peek ${id} to see the request.`,
            )
          }
          return
        }
        yield* Ref.set(r.blockedNotified, false)
        // Worked: seen working in this process, or a turn-start report line of this round — the report file carries the
        // proof across a vibestd restart, so a lost turn is lost, not "not started" (§5).
        const worked = (yield* Ref.get(r.sawWorking)) || (yield* reportStartedSince(id, session.turnPromptedAt))
        const idle = s === "idle"
        const ended = idle && worked
        const now = yield* Clock.currentTimeMillis
        // A prompt that failed part way (the runtime refused it, the connection broke, vibestd stopped): the session sat idle and
        // never moved. Its messages already failed with their notices; close the turn so the queue moves again.
        if (idle && !ended && now - session.turnPromptedAt > Duration.toMillis(CONFIRM_TIMEOUT)) {
          yield* db.updateSession(id, { turnState: "not_started", lastActive: now })
          yield* notice(
            session,
            `task_not_started: vibest did not see ${id} start the turn it was sent (if it starts it late, that turn's result is not collected); it is idle and takes queued messages again.`,
          )
          return yield* deliverQueued(h, { ...session, turnState: "not_started" }, terminal)
        }
        if (!ended) return yield* Ref.set(r.endedAt, undefined)
        const endedAt = yield* Ref.updateAndGet(r.endedAt, (e) => e ?? now)
        if (now - endedAt! <= Duration.toMillis(HOOK_GRACE)) return
        yield* Effect.logInfo(`lost ${id}: terminal tail\n${yield* paneTail(h, terminal)}`)
        yield* finish(
          session,
          "lost",
          "",
          `the turn ended without a report: the harness stopped without firing its turn-end hook (an error it has no hook for, such as a usage limit?); ${peekHint(id)}`,
        )
      })

      const checkLocked = (id: string) => {
        const parked: { paste?: Effect.Effect<void, unknown, FileSystem.FileSystem>; leave?: Effect.Effect<void> } = {}
        return Effect.gen(function* () {
          // A paste is counted from inside the lock until it ends, so a planned Stop never cuts it off (it would paste twice).
          yield* locked(id)(
            check(id, parked).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  if (parked.paste) parked.leave = drain.track(`paste ${id}`)
                }),
              ),
            ),
          )
          // The pickup wait lives in `paste` and must not hold the lock `check` just released.
          if (parked.paste) yield* parked.paste
        }).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              if (parked.leave) yield* parked.leave
              if (!parked.paste) return
              yield* Ref.set((yield* track(id)).pasting, false)
            }),
          ),
          logged(`check ${id}`),
          Effect.provideContext(platform),
        )
      }
      nextCheck.run = checkLocked

      // ---- send / interrupt / remove ----

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

      /**
       * Hand an idle session its queued messages, resuming its harness first when the process is gone. Caller holds the
       * lock. A busy session keeps them until `check` sees it idle: never paste into a dialog or a running turn (SPEC §8.4).
       */
      const deliver = Effect.fn("Sessions.deliver")(function* (id: string) {
        const session = yield* getRow(id)
        // Read under the lock: a Send accepted just before `vibest archive` must not bring the archived session back.
        if (session.metadata.archived || session.metadata.removed)
          return yield* new NoSuchSession({ id, message: `${id} was archived; run a new session` })
        if (
          session.turnState === "open" ||
          session.status === "blocked" ||
          (session.startedAt === null && session.exitedAt === null)
        )
          return
        const h = yield* live(session)
        const terminal = session.address
        const seen = yield* agentState(h, terminal)
        const state = stateOf(seen)
        if (state !== undefined && state !== "unknown" && busy(state)) return
        if (seen === "absent" || (state === "unknown" && !(yield* alive(h, terminal)))) {
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

      /**
       * Queue the message and deliver it in vibestd's scope, so the caller may go away once the row is written. When this
       * delivery fails for good, this message (if nothing handled it meanwhile) is failed and the session's owner told;
       * other queued messages are left to their own deliveries. Runtime unreachable, or vibestd stopping: it stays pending for
       * the poll's next check.
       */
      const send = (id: string, message: string) =>
        Effect.gen(function* () {
          const session = yield* getRow(id)
          const worktree = yield* worktreeOf(session)
          if (session.metadata.archived || session.metadata.removed || !(yield* fs.exists(worktree).pipe(Effect.orDie)))
            return yield* new NoSuchSession({ id, message: `${id} was archived; run a new session` })
          // Archived since the read above (vibest run --archive-on-completion decides under the session's lock, not this one): refused, never accepted.
          const row = yield* db.insertSend(id, message)
          if (!row) return yield* new NoSuchSession({ id, message: `${id} was archived; run a new session` })
          // Under the session's lock, like every other change to its rows.
          const failed = (cause: Cause.Cause<unknown>) =>
            Effect.gen(function* () {
              // Only what a retry can fix keeps the message queued (§3 `RuntimeError` codes); a refused start is final.
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
              yield* undelivered(session, [row], errorMessage(cause))
            })
          yield* Effect.forkIn(
            locked(id)(deliver(id).pipe(Effect.catchCause(failed))).pipe(
              logged(`send ${id}`),
              Effect.provideContext(platform),
            ),
            scope,
          )
        })

      const interrupt = (id: string) =>
        getRow(id).pipe(
          Effect.flatMap((known) =>
            locked(id)(
              Effect.gen(function* () {
                const session = yield* getRow(id)
                const h = yield* live(session)
                const terminal = session.address
                // A result that is already in is delivered; a check still running is killed, not waited out. A
                // failing idle hook is delivered failed by collectResult itself, so no branch is needed for it.
                const collected = yield* collectResult(h, session, "stop")
                if (collected === "delivered")
                  return { message: `${id} had already finished its turn; its result is delivered` }
                const seen = yield* agentState(h, terminal)
                const state = stateOf(seen)
                if (state === undefined || !busy(state))
                  return { message: `${id} is not working; nothing to interrupt` }
                // Waiting under the lock: no check sees the stopped turn as one whose hook never fired.
                if (!(yield* interruptAgent(h, session, terminal)))
                  return yield* new SessionBusy({
                    id,
                    message: `${id} did not stop within ${Duration.format(STOP_WAIT)}; it may still be working`,
                  })
                // The next round starts its attempt count at zero, same as `finish`.
                const { check: _check, ...metadata } = session.metadata
                yield* db.closeTurn(id, "interrupted", {
                  lastActive: yield* Clock.currentTimeMillis,
                  ...(session.metadata.check ? { metadata } : {}),
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

      /**
       * Remove a session for good (SPEC §8.6a): a working one is interrupted first (bounded by
       * STOP_WAIT), and removal goes on whether or not it stopped, since closing its terminal ends it. Mark it archived (and removed, so older
       * readers still see the tombstone; never resumed, its queue failed once), then hand its terminal and worktree to Remove.release.
       * The caller holds the session's lock and its `stopping` flag. `unlessPending` (`vibest run --archive-on-completion`): never interrupt,
       * and tombstone only while it is idle and no Send is pending, else change nothing and return undefined.
       */
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
          // Archived before anything is closed: from here no Send, check or resume brings it back.
          if (!(session.metadata.archived || session.metadata.removed)) {
            if (options.unlessPending) {
              // One transaction with Send's insert: a message accepted before it wins, one after it is refused.
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
          // The check's cwd is this worktree. Kill it before release, or a live process keeps the worktree.
          const running = yield* Ref.get((yield* track(id)).checking)
          if (running) yield* Fiber.interrupt(running.fiber)
          // A row that already exited named a terminal a previous remove closed: nothing of ours is left to close.
          const out = yield* removal.release({
            h,
            session,
            terminal: session.exitedAt === null ? terminal : undefined,
            keepWorktree: options.keepWorktree,
            reasons,
          })
          // The project workspace's live count no longer includes the archived session.
          yield* recount(session.runtime, session.projectId).pipe(Effect.ignore)
          return out
        })

      const remove = (id: string, options: { readonly keepWorktree?: boolean | undefined } = {}) =>
        Effect.gen(function* () {
          yield* getRow(id)
          const { r, already } = yield* stop(id)
          if (already) return yield* new SessionBusy({ id, message: `${id} is already being removed` })
          const out = (yield* locked(id)(removeLocked(id, options)).pipe(Effect.ensuring(Ref.set(r.stopping, false))))!
          const row = yield* getRow(id)
          if (options.keepWorktree && !row.metadata.keptWorktree)
            yield* db.updateSession(id, { metadata: { ...row.metadata, keptWorktree: true } })
          // An owner archived first kept the shared worktree for this borrower (vibest run --peer); nobody shares it now.
          const owner = row.metadata.peer
          const ownerRow = owner === undefined ? undefined : yield* db.getSession(owner)
          if (
            owner === undefined ||
            options.keepWorktree ||
            !ownerRow?.metadata.archived ||
            ownerRow.metadata.keptWorktree
          )
            return out
          const later = (why: string) => ({
            ...out,
            reasons: [
              ...out.reasons,
              `${owner}'s shared worktree kept: ${why}; run vibest archive ${owner} to remove it`,
            ],
          })
          if (out.processes !== "exited") return later(`${id}'s processes are not confirmed gone`)
          const { r: o, already: ownerStopping } = yield* stop(owner)
          if (ownerStopping) return out
          return yield* locked(owner)(removeLocked(owner, {})).pipe(
            Effect.ensuring(Ref.set(o.stopping, false)),
            Effect.map((freed) => {
              if (!freed) return out
              const why = freed.reasons.length > 0 ? ` (${freed.reasons.join("; ")})` : ""
              return { ...out, reasons: [...out.reasons, `${owner}'s shared worktree ${freed.worktree}${why}`] }
            }),
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause) : Effect.succeed(later(errorMessage(cause))),
            ),
          )
        }).pipe(
          Effect.catchTag("PlatformError", () => Effect.die(new Error("a platform error blocked a remove"))),
          Effect.provideContext(platform),
        )

      /**
       * `vibest run --archive-on-completion` (SPEC §8.6b): once a completed result reached the coordinator, archive the session as
       * `vibest archive` would, unless it still has work: a message queued or a newer turn. What became of it follows as a notice.
       */
      const archiveDelivered = (row: InboxRow) =>
        Effect.gen(function* () {
          if (row.kind !== "result") return
          const id = row.sessionId
          const owner = yield* db.getSession(id)
          if (!owner?.metadata.archive || owner.metadata.archived || owner.metadata.removed) return
          if (row.details.status !== "completed") return
          // Each delivered result takes its turn under the lock, so one delivered while another archive holds it still gets its own look.
          yield* locked(
            id,
            true,
          )(
            Effect.gen(function* () {
              // Looked up under the lock: an ended session's flags may be dropped while nobody holds it.
              const r = yield* track(id)
              // An vibest archive already running does it.
              if (yield* Ref.getAndSet(r.stopping, true)) return
              yield* Effect.gen(function* () {
                const session = yield* getRow(id)
                if (session.metadata.archived || session.metadata.removed) return
                const skip = (why: string) =>
                  notice(session, `${id} not archived (vibest run --archive-on-completion): ${why}`)
                // The newest result decides: a newer completed one already delivered archives it now; one not delivered yet takes its own turn once it is.
                const latest = yield* db.latestInbox(id, "result")
                // It has work again (a message was sent to it or it started a new turn): its next completed result archives it.
                // Nothing for the coordinator to do, so no notice (each notice is a coordinator turn).
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
                // The runtime can still read `working` right after the turn-end hook.
                const settled = yield* settleAfterInterrupt(h, terminal)
                if (!settled)
                  return yield* skip(
                    `it did not go idle within ${Duration.format(STOP_WAIT)}; run vibest archive ${id}`,
                  )
                const out = yield* removeLocked(id, { unlessPending: true })
                // It has work again (removeLocked refused): no notice, as above.
                if (!out) return
                const kept = out.reasons.length > 0 ? ` Kept because: ${out.reasons.join("; ")}.` : ""
                const again = out.processes === "exited" ? "" : ` Run vibest archive ${id} again to check.`
                // The owner was archived while this session shared its worktree: nobody else removes it now.
                const owner = session.metadata.peer
                const leftover =
                  owner && (yield* db.getSession(owner))?.metadata.archived
                    ? ` ${owner} is archived too: run vibest archive ${owner} to remove the shared worktree.`
                    : ""
                // A clean archive gives the coordinator nothing to do: only something kept or left over is worth a notice (a coordinator turn).
                if (kept || again || leftover)
                  yield* notice(
                    session,
                    `${id} archived (vibest run --archive-on-completion): terminal ${out.pane}, worktree ${out.worktree} at ${out.path}, branch ${out.branch ?? "(none)"} kept.${kept}${again}${leftover}`,
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
                // Cleared before the lock is let go, so the next result's turn never finds it still set.
                Effect.ensuring(Ref.set(r.stopping, false)),
              )
            }),
          )
        })

      // ---- views ----

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

      /** List keeps a row whose directory cannot be named. No path is guessed and git is not asked. */
      const unlocated = (session: SessionRow): SessionView => ({
        ...session,
        worktree: "",
        repositoryRoot: undefined,
        git: undefined,
      })

      const get = (id: string) => getRow(id).pipe(Effect.flatMap(view), Effect.provideContext(platform))
      const list = (filter: { projectId?: number; stopped?: boolean } = {}) =>
        db.listSessions(filter).pipe(
          Effect.flatMap((rows) =>
            Effect.forEach(rows, (row) =>
              view(row).pipe(Effect.catchTag("NoSuchSession", () => Effect.succeed(unlocated(row)))),
            ),
          ),
          Effect.provideContext(platform),
        )

      // ---- background: events, poll, recovery (SPEC §8.8, §9) ----

      /** One event of any registered runtime (§5): re-evaluate the session that owns the terminal it names. */
      const onTerminalEvent = (event: RuntimeEvent) =>
        Effect.gen(function* () {
          if (event.type === "reset") {
            yield* republish()
            return
          }
          const id = yield* sessionAt(event.terminal)
          if (id === undefined) return
          if (event.type === "state" && event.state === "working") yield* Ref.set((yield* track(id)).sawWorking, true)
          yield* checkLocked(id)
        })

      // The registry merges every registered runtime's events (each share ends with its plugin): one follower here.
      yield* Effect.forkIn(
        runtimes.events.pipe(Stream.runForEach((event) => onTerminalEvent(event).pipe(logged(`runtime event`)))),
        scope,
      )

      const checkAll = db.listSessions().pipe(
        Effect.flatMap((rows) =>
          Effect.forEach(rows, (row) => checkLocked(row.id), { concurrency: "unbounded", discard: true }),
        ),
        Effect.andThen(sweep),
      )

      // Recovery: put the labels back (the runtime does not keep them), then the poll evaluates every row.
      yield* republish()
      yield* Effect.forkIn(checkAll.pipe(Effect.repeat(Schedule.spaced(POLL))), scope)

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

      const resultReady = (id: string) => Effect.forkIn(checkLocked(id), scope).pipe(Effect.asVoid)

      return Sessions.of({
        spawn,
        send,
        interrupt,
        peek,
        remove,
        get,
        list,
        check: checkLocked,
        resultReady,
        userPrompt,
        republish: republish().pipe(Effect.provideContext(platform)),
        inMemory: SynchronizedRef.get(tracked).pipe(
          Effect.map((map) => ({ tracked: HashMap.size(map), locks: locks.size() })),
        ),
      })
    })

  /** VIBEST_MAX_SESSIONS unset = no limit. */
  static readonly layer = Layer.effect(
    Sessions,
    Config.option(Config.Int("VIBEST_MAX_SESSIONS")).pipe(
      Effect.flatMap((max) => Sessions.make({ maxSessions: Option.getOrUndefined(max) })),
    ),
  )
}
