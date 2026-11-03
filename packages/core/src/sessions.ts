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
// agent goes idle after working or its process exits; the result is the integration's turn end (TurnEnds).
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
  Ref,
  Schedule,
  Stream,
  SynchronizedRef,
} from "effect"
import type { Scope } from "effect"
import { Hex } from "effect/encoding"
import { ChildProcessSpawner } from "effect/process"

import { Agents } from "./agents.ts"
import { Db, type InboxRow, type SessionRow } from "./db.ts"
import { Drain } from "./drain.ts"
import {
  encodeCommand,
  harnessOptions,
  Harness,
  Harnesses,
  HarnessUnavailable,
  type HarnessId,
  preflight,
  type HarnessAdapter,
} from "./harness.ts"
import { Inbox } from "./inbox.ts"
import { keyedLock } from "./keyed-lock.ts"
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
  type RuntimeEvent,
  stateOf,
  type Terminal,
  type AgentSeen,
} from "./runtimes.ts"
import { Subscriptions } from "./subscriptions/service.ts"
import { type TurnEnded, TurnEnds } from "./turn-ends.ts"
import { allocationParentBlocked, gitState, type GitState, mainCheckout, repositoryDirectoryName } from "./worktree.ts"
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
/** The lock key of a session directory, beside the session-id keys (8 hex, never a path). */
const directoryLock = (directory: string) => `directory:${directory}`

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
  /** When the open turn was last seen working: a state, an event, or a reported turn start. */
  readonly sawWorking: Ref.Ref<boolean>
  readonly endedAt: Ref.Ref<number | undefined>
  readonly blockedNotified: Ref.Ref<boolean>
  /** True while core is sending the prompt text. The hook that fires then is the paste's echo, not a typed round. */
  readonly prompting: Ref.Ref<boolean>
  readonly stopping: Ref.Ref<boolean>
}

const newTracked: Effect.Effect<Tracked> = Effect.all({
  sawWorking: Ref.make(false),
  endedAt: Ref.make<number | undefined>(undefined),
  blockedNotified: Ref.make(false),
  prompting: Ref.make(false),
  stopping: Ref.make(false),
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
  /** Where its results go instead of its parent (`vibest run --report-to`): a session of the same project. */
  readonly reportTo?: string | undefined
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
    /** `from`: the session that sends it (its turn's result then goes back to it); none for the user. */
    readonly send: (id: string, message: string, from?: string) => Effect.Effect<void, NoSuchSession>
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
    /** A turn end an integration reported (RPC `TurnEnd`, or the HTTP hook): kept, then a check is scheduled; returns at once (SPEC §7, §9). */
    readonly turnEnded: (id: string, end: TurnEnded) => Effect.Effect<void>
    /** Schedule a check of session `id` and return at once (what `turnEnded` does after keeping the end). */
    readonly resultReady: (id: string) => Effect.Effect<void>
    /** An integration's report of what the harness does in its open turn (`turn.start`, a tool call, `blocked`). */
    readonly activity: (
      id: string,
      now: "working" | { readonly blocked: "permission" | "question" },
    ) => Effect.Effect<void>
    /** RPC `Prompt`: the user typed into a subagent's terminal; with no round open, that opens one. */
    readonly userPrompt: (id: string, text: string, at?: number) => Effect.Effect<void, never, FileSystem.FileSystem>
    /** Terminal and workspace labels again, after the runtime dropped them. How many terminals were labelled. */
    readonly republish: Effect.Effect<number>
    /** Entries vibestd keeps in memory for sessions (vibestd-state.md 5): tests check they shrink back once sessions end. */
    readonly inMemory: Effect.Effect<{
      readonly tracked: number
      readonly locks: number
      readonly turnEnds: number
      readonly turnStarts: number
    }>
    /** The live agents (main agents too) whose recorded integration is not this vibestd's (`vibest update`). */
    readonly outdated: Effect.Effect<ReadonlyArray<Outdated>>
    /** Restart these agents in place: subagents first, at most RESTART_CONCURRENCY at a time, then main agents. */
    readonly restart: (ids: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<Restarted>>
    /**
     * `restart` in vibestd's own scope, once process `after` (the `vibest update` that asked, which may run inside one of
     * these agents) has exited or AFTER_WAIT passed. Returns at once.
     */
    readonly restartLater: (ids: ReadonlyArray<string>, after: number | undefined) => Effect.Effect<void>
  }
>()("vibest/Sessions") {
  /** `maxSessions`: non-stopped sessions on this machine; undefined = no limit. */
  static readonly make = (options: { readonly maxSessions: number | undefined }) =>
    Effect.gen(function* () {
      const db = yield* Db
      const runtimes = yield* Runtimes
      const harness = yield* Harness
      const harnesses = yield* Harnesses
      const agents = yield* Effect.serviceOption(Agents)
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
      const turnEnds = yield* TurnEnds
      const platform = yield* Effect.context<Platform>()
      const scope = yield* Effect.scope

      const tracked = yield* SynchronizedRef.make(HashMap.empty<string, Tracked>())
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
          yield* turnEnds.sweep((id) => live.has(id) || locks.busy(id))
          let next = map
          for (const [id, r] of map) {
            if (live.has(id) || locks.busy(id)) continue
            const inFlight = (yield* Ref.get(r.stopping)) || (yield* Ref.get(r.prompting))
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

      /** The directory the session works in, as its row records it (a `--peer` session records the one it shares). */
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

      /** Ready for input (§5). A harness whose integration reports it (`ready: "integration"`) is ready once that report
       * is on its row (a restart or move removes the previous one); any other once the runtime's `state` says idle,
       * working or blocked. While neither (a harness still starting, or showing a startup dialog such as Claude's folder
       * trust) the harness's startup step answers what it can (SPEC §8.2 step 5). A runtime without `state` and a harness
       * without a report are ready when `open` returned. */
      const settled = (seen: AgentSeen) => seen !== "absent" && seen !== "unknown"
      const awaitReady = (h: Runtime, terminal: Terminal, adapter: HarnessAdapter, id: string) =>
        Effect.gen(function* () {
          const reports = adapter.reportsState
          if (h.state === undefined && !reports) return "unknown" as AgentState
          const step = adapter.startup ? yield* adapter.startup : undefined
          const screen = h.read(terminal, 40).pipe(Effect.orElseSucceed(() => ""))
          const look = Effect.gen(function* () {
            const seen: AgentSeen = h.state === undefined ? "unknown" : yield* agentState(h, terminal)
            const ready = reports ? (yield* db.readyAt(id)) !== undefined : settled(seen)
            return { seen, ready }
          })
          return yield* look.pipe(
            Effect.flatMap((now) => {
              if (now.ready || settled(now.seen) || step === undefined) return Effect.succeed(now)
              // The runtime cannot tell yet (a startup dialog): answer it with the harness's own step.
              return step({
                screen,
                sendKeys: (keys) => h.send(terminal, { keys: [...keys] }).pipe(Effect.ignore),
              }).pipe(Effect.as(now))
            }),
            Effect.repeat({ until: (now) => now.ready, schedule: TICK }),
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
            // Reported ready while the runtime cannot tell yet: idle, it takes input.
            Effect.map((now): AgentState =>
              reports && !settled(now.seen) ? "idle" : (stateOf(now.seen) ?? "unknown"),
            ),
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

      /**
       * One look (§5): the integration reported the turn start (`activity`), the runtime reports it working or blocked
       * (a harness without such an integration), or the integration reported a typed turn start of this round.
       */
      const pickupNow = (h: Runtime, session: SessionRow, terminal: Terminal) =>
        Effect.gen(function* () {
          const r = yield* track(session.id)
          if (yield* Ref.get(r.sawWorking)) return true
          if (harnesses.get(session.harnessId).reportsState)
            return yield* turnEnds.startedSince(session.id, session.turnPromptedAt)
          const seen = yield* agentState(h, terminal)
          const state = stateOf(seen)
          if (state === "working" || state === "blocked") {
            yield* Ref.set(r.sawWorking, true)
            yield* db.updateSession(session.id, { status: state })
            return true
          }
          // A turn start the integration reported for this round (the Ref alone misses one that came and went between looks).
          if (yield* turnEnds.startedSince(session.id, session.turnPromptedAt)) {
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

      type Collected = "none" | "delivered"
      // Assigned once `collectResult` exists. `prompt` runs only after `Sessions.make` finishes.
      let collectResult: (
        h: Runtime | undefined,
        session: SessionRow,
      ) => Effect.Effect<
        Collected,
        RuntimeError | NoSuchSession | PlatformError.PlatformError,
        ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
      > = () => Effect.die("collectResult")

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
        turnEnds,
        track,
        lock: locks.withLock,
        worktreeOf,
        undelivered,
        logged,
        prompt,
        route: (session, status, output) =>
          db.replyTo(session.id).pipe(
            Effect.flatMap((recipients) =>
              plugins.result({
                sessionId: session.id,
                agentType: session.agent,
                status,
                output,
                recipients: [...recipients],
              }),
            ),
          ),
        limitMove: limit.move,
      })
      collectResult = rounds.collectResult
      const { finish, deliverQueued, userPrompt } = rounds

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
        agentRules: (agent) => {
          const definition = Option.isSome(agents) ? agents.value.of(agent) : undefined
          return { spawn: definition?.can.spawn ?? false, rules: definition?.rules }
        },
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
        turnEnds,
        rulesFile: layout.rulesFile,
        fs: { remove: (p, o) => fs.remove(p, o), readFileString: (p) => fs.readFileString(p) },
        uuid: crypto.randomUUIDv4.pipe(Effect.orDie),
        terminate: processes.terminate,
        platform,
      })
      limit.move.rerun = move.rerun

      const newId = crypto.randomBytes(4).pipe(Effect.map(Hex.encode), Effect.orDie)

      /** The `machines[]` of `agent.start.before` (§7), via the shared helper. */
      const machinesListing = machines(
        runtimes,
        harnesses.all().map((adapter) => adapter.id),
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
       * The directory `vibest run --peer` shares: the named session's, when it is in the same project, not archived, in
       * the same runtime, and its directory is still on disk in this repository. Nothing links the two afterwards.
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
          return worktree
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
        if (harnesses.find(harnessId) === undefined)
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
        /** `shared`: the directory of the session `--peer` named, which this one works in too. */
        const admit = (shared: string | undefined) =>
          Effect.gen(function* () {
            const refuse = (message: string) => new AllocationFailed({ message })
            const folders = yield* listProjectRepositories(root).pipe(
              Effect.mapError((e) => refuse(`${root}: ${e.message}`)),
            )
            const key = input.key
            const base = {
              ...(Object.keys(decision.decidedBy).length > 0 ? { routing } : {}),
              ...(input.archive ? { archive: true } : {}),
            }
            let cwd = shared
            if (cwd === undefined) {
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
              yield* fs.makeDirectory(parentPath, { recursive: true }).pipe(Effect.mapError((e) => refuse(e.message)))
              const scripted = allocationNameSource.leaves
              const attempts =
                scripted === undefined ? ALLOCATION_NAME_ATTEMPTS : Math.min(scripted.length, ALLOCATION_NAME_ATTEMPTS)
              for (let i = 0; i < attempts && cwd === undefined; i++) {
                const candidate = scripted?.[i] ?? Hex.encode(yield* crypto.randomBytes(2).pipe(Effect.orDie))
                if (!ALLOCATION_LEAF.test(candidate)) continue
                const where = layout.allocationWorktree(repository, candidate)
                // The name is reserved by creating its directory: an atomic mkdir, which fails when anything is there.
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
              harnessSessionId:
                adapter.conversation === "assigned" ? yield* crypto.randomUUIDv4.pipe(Effect.orDie) : null,
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
              key,
              options.maxSessions,
              cwd,
              decision.prompt,
              input.parentSessionId,
              input.reportTo,
            )
            if (!inserted) {
              // The directory this spawn reserved goes again (still empty: nothing was started in it).
              if (shared === undefined) yield* fs.remove(cwd, { recursive: true }).pipe(Effect.ignore)
              return yield* new LimitReached({ limit: options.maxSessions! })
            }
            return (yield* db.getSession(id))!
          })
        // `--peer`: under the directory's lock, which an archive holds while it decides whether that directory goes,
        // so no archive (of the named session or of any other session in it) removes what this one is about to share.
        const row =
          input.peer === undefined
            ? yield* admit(undefined)
            : yield* locks.withLock(directoryLock((yield* db.sessionDirectory(input.peer)) ?? ""))(
                Effect.gen(function* () {
                  const shared = yield* peerOf(input, input.peer!, runtimeKind, decision.machine.id)
                  yield* peerAdmitPause.wait
                  return yield* admit(shared)
                }),
              )
        // The launch holds the lock before spawn returns, so no check sees the row as an abandoned `starting` one.
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

      /** The owner is told once per wait: the session waits on the person. */
      const blockedNotice = (session: SessionRow, reason: "permission" | "question") =>
        Effect.gen(function* () {
          const since = new Date(yield* Clock.currentTimeMillis)
          const hhmm = [since.getHours(), since.getMinutes()].map((n) => String(n).padStart(2, "0")).join(":")
          const what = reason === "permission" ? "a permission decision" : "an answer to its question"
          yield* notice(
            session,
            `${session.id} (${session.harnessId}) has been waiting for ${what} since ${hhmm}. Run vibest peek ${session.id} to see the request.`,
          )
        })

      /**
       * What an integration reported the harness doing in its open turn: working (a turn start, a tool call) or blocked
       * on the person (told once per wait). Outside a turn it changes nothing. No lock: status is memory only.
       */
      const activity = Effect.fn("Sessions.activity")(function* (
        id: string,
        now: "working" | { readonly blocked: "permission" | "question" },
      ) {
        const session = yield* db.getSession(id)
        if (!session || session.turnState !== "open") return
        const r = yield* track(id)
        yield* Ref.set(r.sawWorking, true)
        const status = now === "working" ? "working" : "blocked"
        if (session.status !== status) yield* db.updateSession(id, { status })
        if (now === "working") return yield* Ref.set(r.blockedNotified, false)
        if (!(yield* Ref.getAndSet(r.blockedNotified, true))) yield* blockedNotice(session, now.blocked)
      })

      const check = Effect.fn("Sessions.check")(function* (id: string) {
        const session = yield* db.getSession(id)
        if (!session) return
        const open = session.turnState === "open"
        // An exited session is resumed by the next message (SPEC §8.4), not by a check. An archived one is vibest archive's alone.
        if ((!open && session.exitedAt !== null) || session.metadata.archived || session.metadata.removed) return
        // vibestd is restarting its harness: no result, exit or queue is decided until the new one is ready (restartAgent).
        if (restarting.has(id)) return
        // A delivery cut off by vibestd stopping (no delivery runs while the lock is held): it may or may not have arrived.
        const cutOff = yield* db.inboxWithStatus(id, "sending")
        if (cutOff.length > 0)
          yield* undelivered(
            session,
            cutOff,
            "vibestd stopped while handing it to the session; it may or may not have arrived",
          )
        const routed = yield* live(session).pipe(Effect.option)
        // No runtime routes it (none recorded, or not registered): its reported turn end is still its result.
        if (Option.isNone(routed)) {
          yield* collectResult(undefined, session)
          return yield* live(session)
        }
        const h = routed.value
        const terminal = session.address
        const r = yield* track(id)
        const maybe = yield* agentState(h, terminal).pipe(Effect.option)
        // Unreachable is no answer: this check tries again on the next poll, the row untouched.
        if (Option.isNone(maybe)) return
        const seen = maybe.value
        const reported = stateOf(seen) === "unknown" ? undefined : stateOf(seen)
        // An integrated harness reports working and blocked itself (`activity`): of the runtime only idle counts (a turn
        // that ended without its event) and whether it is gone. Any other: the runtime's state as it reports it now;
        // `unknown` is no answer, the process fallback decides (§5).
        const own = harnesses.get(session.harnessId).reportsState
        const state = !own
          ? reported
          : session.status === "blocked"
            ? "blocked"
            : reported === "idle"
              ? "idle"
              : undefined
        if (!own && state !== undefined && session.status !== state)
          yield* db.updateSession(session.id, { status: state })
        if (!own && (state === "working" || state === "blocked")) yield* Ref.set(r.sawWorking, true)
        if ((yield* collectResult(h, session)) !== "none") {
          // Its turn ended (the integration said so): idle until it reports the next start.
          if (own) yield* db.updateSession(id, { status: "idle" })
          return
        }
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
        const s = state ?? "unknown"
        if (!open) {
          // Its turn ended (the integration said so): idle until it reports the next start.
          if (own && session.status !== "idle" && session.status !== "blocked")
            yield* db.updateSession(id, { status: "idle" })
          if (s !== "working" && s !== "blocked") yield* deliverQueued(h, session, terminal)
          return
        }
        if (s === "blocked") {
          if (!(yield* Ref.getAndSet(r.blockedNotified, true))) yield* blockedNotice(session, "permission")
          return
        }
        yield* Ref.set(r.blockedNotified, false)
        // Worked: seen working in this process, a turn start reported for this round, or the stored proof that survives a
        // vibestd restart (the turn was typed, or a message was delivered into it), so a lost turn is lost, not "not started" (§5).
        const worked =
          (yield* Ref.get(r.sawWorking)) ||
          (yield* turnEnds.startedSince(id, session.turnPromptedAt)) ||
          (yield* db.turnTaken(id))
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

      const checkLocked = (id: string) =>
        locked(id)(check(id)).pipe(logged(`check ${id}`), Effect.provideContext(platform))

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
          (session.startedAt === null && session.exitedAt === null) ||
          // Its harness is being restarted in its own terminal: never resumed in another one; delivered once it is back.
          restarting.has(id)
        )
          return
        const h = yield* live(session)
        const terminal = session.address
        const seen = yield* agentState(h, terminal)
        const state = stateOf(seen)
        // An integrated harness is busy only within a turn or while blocked (both checked above).
        if (!harnesses.get(session.harnessId).reportsState && state !== undefined && state !== "unknown" && busy(state))
          return
        if (seen === "absent" || (state === "unknown" && !(yield* alive(h, terminal)))) {
          if (harnesses.get(session.harnessId).conversation === "reported" && !session.harnessSessionId)
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
      const send = (id: string, message: string, from?: string) =>
        Effect.gen(function* () {
          const session = yield* getRow(id)
          const worktree = yield* worktreeOf(session)
          if (session.metadata.archived || session.metadata.removed || !(yield* fs.exists(worktree).pipe(Effect.orDie)))
            return yield* new NoSuchSession({ id, message: `${id} was archived; run a new session` })
          // Archived since the read above (vibest run --archive-on-completion decides under the session's lock, not this one): refused, never accepted.
          const row = yield* db.insertSend(id, message, from)
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
                // A result that is already in is delivered.
                const collected = yield* collectResult(h, session)
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
                yield* db.closeTurn(id, "interrupted", { lastActive: yield* Clock.currentTimeMillis })
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
          // A row that already exited named a terminal a previous remove closed: nothing of ours is left to close.
          // Under the directory's lock: a `--peer` spawn into it waits, then sees it gone or is seen as its sharer.
          const out = yield* locks.withLock(directoryLock((yield* db.sessionDirectory(id)) ?? ""))(
            removal.release({
              h,
              session,
              terminal: session.exitedAt === null ? terminal : undefined,
              keepWorktree: options.keepWorktree,
              reasons,
            }),
          )
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
          return out
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
                // A clean archive gives the coordinator nothing to do: only something kept or left over is worth a notice (a coordinator turn).
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

      // A settlement: a turn that ended during a drain (`vibest update`, `vibest daemon restart`) is still written.
      const resultReady = (id: string) =>
        Effect.forkIn(
          locked(id, true)(check(id)).pipe(logged(`check ${id}`), Effect.provideContext(platform)),
          scope,
        ).pipe(Effect.asVoid)
      const turnEnded = (id: string, end: TurnEnded) =>
        turnEnds.ended(id, end).pipe(
          // One line per reported end (no text): what vibestd.log shows of a turn end that writes no result.
          Effect.andThen(Effect.log(`turn end ${id} (${end.harness}${end.interrupted ? ", interrupted" : ""})`)),
          Effect.andThen(resultReady(id)),
        )

      // ---- restart in place (`vibest update`): restart.ts ----
      const { outdated, restart, restartLater } = sessionRestart({
        db,
        runtimes,
        harnesses,
        processes,
        restarting,
        turnEnds,
        inbox,
        scope,
        locked: (id) => locked(id),
        launchArgv: (session, resume, key) => launchArgv(session, resume, key).pipe(Effect.provideContext(platform)),
        worktreeOf,
        withPlatform: (effect) => effect.pipe(Effect.provideContext(platform)),
        awaitReady,
        prompt: (h, session, terminal, text) =>
          prompt(h, session, terminal, text).pipe(Effect.provideContext(platform)),
      })

      return Sessions.of({
        spawn,
        send,
        interrupt,
        peek,
        remove,
        get,
        list,
        check: checkLocked,
        turnEnded,
        resultReady,
        activity: (id, now) => activity(id, now).pipe(Effect.provideContext(platform), Effect.orDie),
        // The start is noted before the round waits for the lock: a send still confirming sees it (pickup proof).
        userPrompt: (id: string, text: string, at?: number) =>
          Effect.gen(function* () {
            const now = at ?? (yield* Clock.currentTimeMillis)
            yield* turnEnds.started(id, now)
            yield* userPrompt(id, text, now)
          }),
        republish: republish().pipe(Effect.provideContext(platform)),
        inMemory: Effect.gen(function* () {
          const map = yield* SynchronizedRef.get(tracked)
          const { ends, starts } = yield* turnEnds.size
          return { tracked: HashMap.size(map), locks: locks.size(), turnEnds: ends, turnStarts: starts }
        }),
        outdated,
        restart,
        restartLater,
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
