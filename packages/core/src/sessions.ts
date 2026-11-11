import { newId, shortId } from "@vibest/schema/id"
import type { AgentRefused } from "@vibest/schema/plugin"
import {
  AllocationFailed,
  LimitReached,
  NoCallingSession,
  NoHarnessChosen,
  NoRuntime,
  NoSuchSession,
  RuntimeUnreachable,
  SessionBusy,
} from "@vibest/schema/session"
import {
  Cause,
  Clock,
  Config,
  Context,
  Crypto,
  Duration,
  Effect,
  FiberSet,
  FileSystem,
  Layer,
  Option,
  Path,
  Predicate,
  Ref,
} from "effect"

import { sessionArchive } from "./archive.ts"
import { Bus, type EngineEvent } from "./bus.ts"
import { Db, type SessionFilter, type SessionRow, sessionEnded } from "./db.ts"
import { Drain } from "./drain.ts"
import { LayerNode } from "./effect/layer-node.ts"
import * as PlatformNode from "./effect/platform.ts"
import * as Engine from "./engine.ts"
import { sessionExecutions } from "./executions.ts"
import { encodeCommand, Harness, Harnesses, HarnessUnavailable } from "./harness.ts"
import { Inbox } from "./inbox.ts"
import { entryCommand, restartArgv } from "./launch.ts"
import { limitMoveBox, sessionMove } from "./move.ts"
import { Layout, VibestCommand } from "./paths.ts"
import { sessionPlacement } from "./placement.ts"
import { errorMessage, Plugins } from "./plugins.ts"
import { Processes } from "./processes.ts"
import { projectRoot, workspaceGit } from "./project-create.ts"
import { CONFIRM_TIMEOUT, sessionPrompting, STOP_WAIT } from "./prompting.ts"
import * as Remove from "./remove.ts"
import { type Outdated, type Restarted, sessionRestart } from "./restart.ts"
import {
  agentState,
  alive,
  paneTail,
  peekHint,
  Runtimes,
  RuntimeError,
  type Runtime,
  stateOf,
  type Terminal,
} from "./runtimes.ts"
import type { Platform } from "./session-types.ts"
import { SessionLive } from "./session/live.ts"
import { SessionLocks } from "./session/locks.ts"
import { sessionSpawn, type SpawnInput, type Spawned } from "./spawn.ts"
import { Subscriptions } from "./subscriptions/service.ts"
import { projectText, sessionSystemPrompt, writeSystemPrompt } from "./system-prompt.ts"
import { Git, gitState, type GitState, mainCheckout } from "./worktree.ts"
export const runtimeEnv = (runtime: string, address: { readonly machine: string; readonly id: string }) =>
  JSON.stringify({ runtime, machine: address.machine, ...(address.id !== "" ? { terminal: address.id } : {}) })

export {
  AllocationFailed,
  LaunchFailed,
  LimitReached,
  NoCallingSession,
  NoHarnessChosen,
  NoRuntime,
  NoSuchSession,
  NotReady,
  RuntimeUnreachable,
  SessionBusy,
} from "@vibest/schema/session"

export { CONFIRM_TIMEOUT, READY_TIMEOUT, STOP_WAIT } from "./prompting.ts"
export { allocationNameSource, defaultSessionName, peerAdmitPause, type SpawnInput, type Spawned } from "./spawn.ts"

export const START_TIMEOUT = Duration.seconds(120)
export const HOOK_GRACE = Duration.seconds(10)
export const TAIL_LINES = 30

const SESSION_DEPS = [
  Bus.node,
  Db.node,
  Drain.node,
  Git.node,
  Harness.node,
  Harnesses.node,
  Inbox.node,
  Plugins.node,
  Processes.node,
  Runtimes.node,
  SessionLive.node,
  SessionLocks.node,
  Subscriptions.node,
  PlatformNode.childProcessSpawner,
  PlatformNode.crypto,
  PlatformNode.fileSystem,
  PlatformNode.layout,
  PlatformNode.path,
] as const

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
      | AllocationFailed
      | LimitReached
      | HarnessUnavailable
      | NoCallingSession
      | NoHarnessChosen
      | NoRuntime
      | AgentRefused
      | NoSuchSession
    >
    readonly send: (
      id: string,
      message: string,
      request?: string,
      sender?: string,
    ) => Effect.Effect<void, NoSuchSession>
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
    readonly list: (filter?: SessionFilter) => Effect.Effect<ReadonlyArray<SessionView>>
    readonly check: (id: string) => Effect.Effect<void>
    readonly userPrompt: (id: string, text: string, at?: number, process?: number) => Effect.Effect<void>
    readonly republish: Effect.Effect<number>
    readonly inMemory: Effect.Effect<{
      readonly tracked: number
      readonly locks: number
      readonly reconciles: number
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
      const sessionLive = yield* SessionLive
      const { restarting, track } = sessionLive
      const bus = yield* Bus
      const platform = yield* Effect.context<Platform>()
      const scope = yield* Effect.scope
      const engine = yield* Engine.make

      const locks = yield* SessionLocks
      const forgetIfDone = (id: string) =>
        locks.withLock(id)(
          Effect.gen(function* () {
            if (!sessionEnded(yield* db.getSession(id))) return
            yield* engine.cancel(`grace:${id}`)
            yield* engine.cancel(`miss:${id}`)
            yield* sessionLive.forget(id)
          }),
        )
      const locked = locks.locked
      const logged = Engine.logFailure

      const notice = (session: SessionRow, message: string) => inbox.enqueue({ sessionId: session.id, message })

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
        rows: ReadonlyArray<{
          readonly id: number
          readonly message: string
          readonly kind?: string
          readonly sender?: string | null
        }>,
        reason: string,
      ) =>
        db
          .setInboxStatus(
            session.id,
            rows.map((r) => r.id),
            "failed",
          )
          .pipe(
            Effect.andThen(
              Effect.forEach(
                [...Map.groupBy(rows, (r) => (r.kind === "send" ? (r.sender ?? null) : null))],
                ([sender, group]) => {
                  const message = `A message to ${session.id} was not delivered: ${reason}\n\n${group.map((r) => r.message).join("\n\n")}`
                  return sender === null ? notice(session, message) : db.insertNoticeTo(sender, message)
                },
                { discard: true },
              ),
            ),
          )

      const dropQueue = (session: SessionRow, reason: string) =>
        db
          .pendingInbox(session.id)
          .pipe(Effect.flatMap((rows) => (rows.length === 0 ? Effect.void : undelivered(session, rows, reason))))

      const live = (session: SessionRow) => runtimes.route(session.runtime)

      const announceExit = (session: SessionRow, execution: number | undefined) =>
        Effect.gen(function* () {
          const queued = yield* db.pendingInbox(session.id)
          const signed = queued.filter((r) => r.kind === "send" && r.sender)
          const unsigned = queued.filter((r) => !signed.includes(r))
          if (signed.length > 0) yield* undelivered(session, signed, `${session.id} exited before it was delivered`)
          yield* db.setInboxStatus(
            session.id,
            unsigned.map((r) => r.id),
            "failed",
          )
          const lost = unsigned.map((r) => r.message).join("\n\n")
          const text = (how: string) =>
            `${session.id} (${session.harnessId}) exited${how}; vibest peek ${session.id} shows its terminal; vibest send ${session.id} resumes it${lost === "" ? "" : `\n\nNot delivered:\n\n${lost}`}`
          if (
            execution !== undefined &&
            (yield* db.closeExecution(session.id, execution, "failed", {
              failure: "the harness exited",
              notice: text(" during an execution"),
            }))
          )
            return
          const last = yield* db.latestReply(session.id)
          yield* notice(
            session,
            text(last?.status === "failed" ? ` after its execution ended with an error: ${last.failure ?? ""}` : ""),
          )
        })

      const { awaitReady, busy, busyOf, settleAfterInterrupt, interruptAgent, prompt } = sessionPrompting({
        db,
        harnesses,
        bus,
        track,
      })

      const vibestEnv = (session: SessionRow, process?: number) => ({
        ...(process === undefined ? {} : { VIBEST_PROCESS: String(process) }),
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
            creator: yield* db.creatorLabel(session.id),
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
        const adapter = yield* harnesses.get(session.harnessId)
        const pluginDir = yield* harness.plugin(adapter.id)
        const id = session.harnessSessionId
        const resumeThis = resume && id !== null && (yield* db.canResumeConversation(session.id, id))
        return [
          adapter.binary,
          ...adapter.launchArgs({
            worktree: yield* worktreeOf(session),
            projectDir: layout.project(session.projectId),
            systemPromptFile: file,
            provider: session.provider,
            model: session.model,
            sessionId: id,
            resume: resumeThis,
            pluginDir,
            vibest,
            env: vibestEnv(session),
          }),
        ]
      })

      const limit = limitMoveBox()
      const { finish, deliverQueued } = sessionExecutions({
        db,
        undelivered,
        prompt,
        handTask: (h, session, terminal, task) => handTask(h, session, terminal, task),
      })

      const handTask = (h: Runtime, session: SessionRow, terminal: Terminal, task: string) =>
        Effect.gen(function* () {
          const first = (yield* harnesses.get(session.harnessId)).systemPromptInPrompt
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

      const { spawn } = sessionSpawn({
        db,
        runtimes,
        harness,
        harnesses,
        plugins,
        drain,
        layout,
        fs,
        path,
        crypto,
        platform,
        scope,
        locks,
        options,
        worktreeOf,
        logged,
        launch,
      })

      const check = Effect.fn("Sessions.check")(function* (id: string) {
        const session = yield* db.getSession(id)
        if (!session || session.metadata.archived || session.metadata.removed) return
        const open = session.executionState === "open"
        const limited = session.executionState === "failed" ? yield* db.limitedExecution(id) : undefined
        if (!open && session.exitedAt !== null && limited === undefined) return
        if (yield* restarting.has(id)) return
        const routed = yield* live(session).pipe(Effect.option)
        if (Option.isNone(routed)) return yield* live(session)
        const h = routed.value
        if (limited !== undefined && session.exitedAt !== null) return yield* afterLimit(h, session, limited, true)
        const terminal = session.address
        const execution = open ? yield* db.openExecution(id) : undefined
        const r = yield* track(id)
        const maybe = yield* agentState(h, terminal).pipe(Effect.option)
        if (Option.isNone(maybe)) return
        const seen = maybe.value
        const state = stateOf(seen) === "unknown" ? undefined : stateOf(seen)
        if (state !== undefined && session.status !== state) yield* db.updateSession(session.id, { status: state })
        if ((state === "working" || state === "blocked") && execution !== undefined)
          yield* db.acceptExecution(id, execution)
        const exited =
          state === undefined &&
          (yield* Effect.gen(function* () {
            const terminalRunning = yield* alive(h, terminal)
            const reportedPid = session.metadata.pid
            return (
              !terminalRunning ||
              (typeof reportedPid === "number" && (yield* processes.liveness(reportedPid)) === "exited")
            )
          }))
        if (limited !== undefined && (yield* afterLimit(h, session, limited, exited))) return
        if (state === undefined) {
          if (exited) {
            const cutOff = session.startedAt === null
            const announce = !cutOff && (open || session.exitedAt === null)
            if (announce) yield* announceExit(session, execution)
            if (session.exitedAt === null) {
              yield* db.updateSession(id, {
                status: "unknown",
                exitedAt: yield* Clock.currentTimeMillis,
                ...(cutOff ? { end: "launch_failed" as const } : {}),
              })
              yield* recount(session.runtime, session.projectId).pipe(Effect.ignore)
            }
            if (cutOff) yield* undoCutOffStart(h, session)
            if (!announce)
              yield* dropQueue(session, `${id} exited before it was delivered; send it again to resume the session`)
            return
          }
          if (!(yield* Ref.getAndSet(r.launchRechecked, true)))
            yield* engine.arm(`launch:${id}`, START_TIMEOUT, checkSession(id))
        } else yield* Ref.set(r.launchRechecked, false)
        if (!(yield* harnesses.get(session.harnessId)).ownSessionId && h.session !== undefined) {
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
              `${shortId(id)} (${session.harnessId}) has been waiting for a permission decision since ${hhmm}. Run vibest peek ${shortId(id)} to see the request.`,
            )
          }
          return
        }
        yield* Ref.set(r.blockedNotified, false)
        const worked = yield* db.executionTaken(id)
        const idle = s === "idle"
        const ended = idle && worked
        const now = yield* Clock.currentTimeMillis
        const unconfirmed = Duration.toMillis(CONFIRM_TIMEOUT) - (now - session.executionPromptedAt)
        if (idle && !ended && unconfirmed <= 0) {
          const closed =
            execution !== undefined &&
            (yield* db.closeExecution(id, execution, "not_started", {
              notice: `task_not_started: vibest did not see ${id} start the execution it was sent (if it starts it late, that execution's reply is not collected); it is idle and takes queued messages again.`,
            }))
          if (closed) yield* deliverQueued(h, { ...session, executionState: "not_started" }, terminal)
          return
        }
        if (idle && !ended) yield* engine.arm(`miss:${id}`, Duration.millis(unconfirmed), checkSession(id))
        if (!ended) return yield* Ref.set(r.endedAt, undefined)
        const endedAt = yield* Ref.updateAndGet(r.endedAt, (e) => e ?? now)
        const grace = Duration.toMillis(HOOK_GRACE) - (now - endedAt!)
        if (grace > 0) return yield* engine.arm(`grace:${id}`, Duration.millis(grace), checkSession(id))
        if (execution === undefined) return
        yield* Effect.logInfo(`lost ${id}: terminal tail\n${yield* paneTail(h, terminal)}`)
        const failure = `the execution ended without a reply: the harness stopped without firing its execution-end hook (an error it has no hook for, such as a usage limit?); ${peekHint(id)}`
        yield* db.closeExecution(id, execution, "lost", {
          failure,
          notice: `${id}'s execution ended with an error: ${failure}`,
        })
      })

      const afterLimit = (
        h: Runtime,
        session: SessionRow,
        limited: { readonly execution: number; readonly process: number | null; readonly failure: string },
        exited: boolean,
      ) =>
        Effect.gen(function* () {
          const rerun = (terminal: Terminal | undefined) =>
            limit.move.rerun(h, session, terminal, "", false, limited.failure, limited.execution)
          if (session.exitedAt !== null) return yield* rerun(undefined)
          const successor = (yield* db.currentProcessId(session.id)) !== limited.process
          if (!successor || exited) return yield* rerun(session.address.id === "" ? undefined : session.address)
          const source = yield* db.limitSource(session.id, limited.execution)
          const task = source === undefined ? "" : source.working || source.delivered
          if (task === "") return false
          yield* handTask(h, session, session.address, task)
          return true
        })

      const checkSession = (id: string): Effect.Effect<unknown, unknown> =>
        locked(id)(check(id)).pipe(Effect.provideContext(platform))

      const checkLocked = (id: string): Effect.Effect<void> => logged(`check ${id}`)(checkSession(id))

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

      const { undoCutOffStart, remove, archiveIfIdle, finishArchive } = sessionArchive({
        db,
        fs,
        removal,
        locks,
        platform,
        getRow,
        live,
        notice,
        dropQueue,
        recount,
        sessionLive,
        locked,
        logged,
        busyOf,
        interruptAgent,
        settleAfterInterrupt,
      })

      const deliver = Effect.fn("Sessions.deliver")(function* (id: string) {
        const session = yield* getRow(id)
        if (session.metadata.archived || session.metadata.removed)
          return yield* new NoSuchSession({ id, message: `${id} was archived; run a new session` })
        if (
          session.executionState === "open" ||
          session.status === "blocked" ||
          (session.startedAt === null && session.exitedAt === null) ||
          (yield* restarting.has(id))
        )
          return
        const h = yield* live(session)
        const terminal = session.address
        const seen = yield* agentState(h, terminal)
        const state = stateOf(seen) === "unknown" ? undefined : stateOf(seen)
        if (state !== undefined && busy(state)) return
        if (state === undefined && !(yield* alive(h, terminal))) {
          if (session.exitedAt !== null && (yield* db.pendingInbox(id)).length === 0) return
          if (!(yield* harnesses.get(session.harnessId)).ownSessionId && !session.harnessSessionId)
            return yield* new NoSuchSession({
              id,
              message: `${id} exited before the runtime reported its session id; spawn a new session`,
            })
          yield* resume(h, session)
        }
        const fresh = (yield* db.getSession(id)) ?? session
        yield* deliverQueued(h, fresh, fresh.address)
      })

      const send = (id: string, message: string, request?: string, sender?: string) =>
        Effect.gen(function* () {
          const session = yield* getRow(id)
          if (request !== undefined && (yield* db.queuedBy(id, request))) return
          const worktree = yield* worktreeOf(session)
          if (session.metadata.archived || session.metadata.removed || !(yield* fs.exists(worktree).pipe(Effect.orDie)))
            return yield* new NoSuchSession({ id, message: `${id} was archived; run a new session` })
          const row = yield* db.insertSend(id, message, request, sender)
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
        }).pipe(Effect.provideContext(platform))

      const deliverNext = (id: string) =>
        locked(id)(db.hasQueued(id).pipe(Effect.flatMap((queued) => (queued ? deliver(id) : Effect.void)))).pipe(
          Effect.provideContext(platform),
        )

      const interrupt = (id: string) =>
        getRow(id).pipe(
          Effect.flatMap((known) =>
            locked(id)(
              Effect.gen(function* () {
                const session = yield* getRow(id)
                const h = yield* live(session)
                const terminal = session.address
                const execution = yield* db.openExecution(id)
                if (execution === undefined)
                  return {
                    message: `${id} is not working; its execution had already finished and its reply is recorded`,
                  }
                const state = stateOf(yield* agentState(h, terminal))
                const runtimeKnows = state !== undefined && state !== "unknown"
                const started = yield* db.executionAccepted(id)
                if (!started && runtimeKnows && !busy(state))
                  return { message: `${id} is not working; nothing to interrupt` }
                if (!(yield* interruptAgent(h, session, terminal)))
                  return yield* new SessionBusy({
                    id,
                    message: `${id} did not stop within ${Duration.format(STOP_WAIT)}; it may still be working`,
                  })
                const closed = yield* db.closeExecution(id, execution, "interrupted")
                if (closed && !runtimeKnows) yield* db.updateSession(id, { status: "idle" })
                const last = closed ? undefined : yield* db.latestReply(id)
                if (!closed && !(last?.execution === execution && last.status === "interrupted"))
                  return {
                    message: `${id} finished its execution before the interrupt took effect; its reply is recorded`,
                  }
                return { message: `${id} interrupted; its terminal, worktree and session are kept` }
              }),
            ).pipe(Effect.catchTags({ RuntimeError: unreachable(known) })),
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
      const list = (filter: SessionFilter = {}) =>
        db.listSessions(filter).pipe(
          Effect.flatMap((rows) =>
            Effect.forEach(rows, (row) =>
              view(row).pipe(Effect.catchTag("NoSuchSession", () => Effect.succeed(unlocated(row)))),
            ),
          ),
          Effect.provideContext(platform),
        )

      const onTerminal = (runtime: string, terminal: Terminal, working: boolean) =>
        Effect.gen(function* () {
          const id = yield* db.sessionAt(runtime, terminal)
          if (id === undefined) return
          const execution = working ? yield* db.openExecution(id) : undefined
          if (execution !== undefined) yield* db.acceptExecution(id, execution)
          yield* checkSession(id)
        })

      const handle = (event: EngineEvent): Effect.Effect<unknown, unknown> => {
        switch (event.type) {
          case "execution.ended":
            return event.data.outcome === "failed"
              ? checkFailed(event.sessionId!)
              : deliverNext(event.sessionId!).pipe(
                  Effect.andThen(event.data.outcome === "completed" ? archiveSoon([event.sessionId!]) : Effect.void),
                )
          case "inbox.moved":
            return event.data.to === "pending" || event.data.to === "delivering"
              ? Effect.void
              : db.inboxParties(event.sessionId!, event.data.inbox).pipe(Effect.flatMap(archiveSoon))
          case "inbox.queued":
            return queued(event.sessionId!, event.seq)
          case "live.state":
            return onTerminal(event.runtime, event.terminal, event.state === "working")
          case "live.exited":
            return onTerminal(event.runtime, event.terminal, false)
          case "process.ended":
            return forgetIfDone(event.sessionId!)
          case "live.reset":
            return republish().pipe(
              Effect.andThen(reconcile({ runtime: event.runtime, machine: event.machine })),
              Effect.provideContext(platform),
            )
          default:
            return Effect.void
        }
      }

      let reconciles = 0
      const reconcile = (where: "all" | { readonly runtime: string; readonly machine?: string }) =>
        Effect.gen(function* () {
          const here = (yield* db.listSessions()).filter(
            (row) =>
              where === "all" ||
              (row.runtime === where.runtime && (where.machine === undefined || row.address.machine === where.machine)),
          )
          const rows = here.filter(
            (row) =>
              !row.metadata.archived &&
              !row.metadata.removed &&
              (row.exitedAt === null || row.executionState === "open"),
          )
          const ended = (yield* db.endedAtLimit)
            .filter((row) => where === "all" || row.runtime === where.runtime)
            .map((row) => row.id)
          const archiving = here.filter(
            (row) => (row.metadata.archived || row.metadata.removed) && row.exitedAt === null && row.address.id !== "",
          )
          yield* Effect.forEach(archiving, (row) => finishArchive(row.id), { concurrency: 8, discard: true })
          yield* Effect.log(
            `reconcile ${where === "all" ? "all" : `${where.runtime}${where.machine ? ` on ${where.machine}` : ""}`}: ${rows.length} live sessions`,
          )
          yield* Effect.forEach([...rows.map((row) => row.id), ...ended], checkLocked, {
            concurrency: 8,
            discard: true,
          })
          for (const project of yield* db.pendingProjects) yield* inbox.deliver(project)
          reconciles++
        })

      const archives = yield* FiberSet.make()
      const archiveSoon = (ids: ReadonlyArray<string>) =>
        Effect.forEach(
          ids,
          (id) =>
            FiberSet.run(
              archives,
              drain.work(
                `archive ${id}`,
                archiveIfIdle(id).pipe(logged(`archive ${id}`), Effect.provideContext(platform)),
                true,
              ),
            ),
          { discard: true },
        )

      const checkFailed = (id: string) =>
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
        entryArgv: (entry) =>
          Effect.gen(function* () {
            yield* db.patchLive(entry.id, { ready: null })
            const root = entry.projectDirectory ?? (yield* db.projectDirectory(entry.projectId)) ?? ""
            const savedId = entry.harnessSessionId
            const command = yield* entryCommand({
              harness: entry.harnessId,
              root,
              provider: entry.provider,
              model: entry.model,
              session: Effect.succeed({
                sessionId: entry.id,
                harnessSessionId:
                  savedId !== null && (yield* db.canResumeConversation(entry.id, savedId)) ? savedId : null,
                projectId: entry.projectId,
                ...(entry.runtime && entry.address ? { runtime: runtimeEnv(entry.runtime, entry.address) } : {}),
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
        userPrompt: (id: string, text: string, at?: number, process?: number) =>
          Effect.gen(function* () {
            const now = at ?? (yield* Clock.currentTimeMillis)
            const prompting = yield* Ref.get((yield* track(id)).prompting)
            yield* db.startObserved(id, prompting || text.trim() === "" ? undefined : text, now, process)
          }),
        republish: republish().pipe(Effect.provideContext(platform)),
        inMemory: Effect.gen(function* () {
          return { tracked: (yield* sessionLive.size).tracked, locks: locks.size(), reconciles }
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
  static readonly configured = (options: { readonly maxSessions: number | undefined }) =>
    LayerNode.make({ service: Sessions, layer: Layer.effect(Sessions, Sessions.make(options)), deps: SESSION_DEPS })

  static readonly node = LayerNode.make({ service: Sessions, layer: Sessions.layer, deps: SESSION_DEPS })
}
