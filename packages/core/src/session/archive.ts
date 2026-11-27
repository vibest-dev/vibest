import type { Sender } from "@vibest/schema/event"
import { sessionLabel } from "@vibest/schema/id"
import { Layout } from "@vibest/schema/layout"
import { NoSuchSession, RuntimeUnreachable, SessionBusy } from "@vibest/schema/session"
import { LayerNode } from "@vibest/util/layer-node"
import { Context, Duration, Effect, FileSystem, Layer } from "effect"

import { type SessionRow, sessionEnded, runtimeOf, terminalOf, exitedAt, archived } from "../database/rows.ts"
import { PlatformNode } from "../effect/platform.ts"
import { Inbox } from "../inbox.ts"
import { InboxStore } from "../inbox/store.ts"
import * as Reactor from "../reactor.ts"
import { Processes } from "../runtime/processes.ts"
import {
  agentState,
  formatTerminal,
  Runtimes,
  sessionState,
  stateOf,
  type Runtime,
  type Terminal,
} from "../runtime/registry.ts"
import { Git } from "../worktree/git.ts"
import { busy, busyOf, Executions, STOP_WAIT } from "./executions.ts"
import { SessionLive } from "./live.ts"
import { directoryLock, SessionLocks } from "./locks.ts"
import { Placement } from "./placement.ts"
import * as Release from "./release.ts"
import { Starts } from "./starts.ts"
import { SessionStore } from "./store.ts"

export * as Archive from "./archive.ts"

const interruptNote = (stopped: boolean) =>
  stopped
    ? "it was working: interrupted, then "
    : `it did not stop within ${Duration.format(STOP_WAIT)} of the interrupt key; `

export const make = Effect.gen(function* () {
  const sessionStore = yield* SessionStore.Service
  const inboxStore = yield* InboxStore.Service
  const fs = yield* FileSystem.FileSystem
  const layout = yield* Layout
  const runtimes = yield* Runtimes.Service
  const inbox = yield* Inbox.Service
  const releaser = yield* Release.make
  const locks = yield* SessionLocks.Service
  const sessionLive = yield* SessionLive.Service
  const { notice, recount, ownTerminal, terminalLocked } = yield* Placement.Service
  const starts = yield* Starts.Service
  const { interruptAgent } = yield* Executions.Service
  const { locked } = locks
  const logged = Reactor.logFailure
  const live = (session: SessionRow) => runtimes.route(runtimeOf(session))
  const dropQueue = inbox.dropQueue

  const getRow = (id: string) =>
    sessionStore
      .getSession(id)
      .pipe(
        Effect.flatMap((session) =>
          session ? Effect.succeed(session) : Effect.fail(new NoSuchSession({ id, message: `no session ${id}` })),
        ),
      )

  const undoCutOffStart = Effect.fn("Archive.undoCutOffStart")(function* (h: Runtime, session: SessionRow) {
    const what = `${sessionLabel(session)} never finished starting (vibestd stopped while it started)`

    if (yield* sessionStore.hadTerminal(session.id)) return yield* notice(session, `${what}.`)
    const ended = yield* getRow(session.id)

    const out = yield* locks.withLock(directoryLock((yield* sessionStore.sessionDirectory(session.id)) ?? ""))(
      releaser.release({ h, session: ended, terminal: undefined, keepWorktree: false, reasons: [] }),
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

  const otherSessionAt = (session: SessionRow, terminal: Terminal) =>
    sessionStore.processesAt(runtimeOf(session), terminal).pipe(
      Effect.map((processes) => {
        const others = processes.filter((p) => p.sessionId !== session.id).map((p) => p.sessionId)

        return others.length > 0 ? `session ${others.join(", ")} runs in it` : undefined
      }),
    )

  const release = (id: string) =>
    sessionStore.getSession(id).pipe(Effect.flatMap((row) => sessionLive.release(id, sessionEnded(row))))

  const archiveOwned = (id: string, options: { readonly keepWorktree?: boolean | undefined }) =>
    Effect.gen(function* () {
      let session = yield* getRow(id)
      const h = session.process === null ? undefined : yield* live(session)
      const recorded = terminalOf(session)
      const owned = yield* ownTerminal(session)
      const reasons: Array<string> = []
      const seen = owned === undefined || h === undefined ? ("absent" as const) : yield* agentState(h, owned)
      const working = busyOf(seen)
      const execution = yield* sessionStore.openExecution(id)

      if (working || execution !== undefined) {
        let stopped = false

        if (working && h !== undefined && owned !== undefined) {
          stopped = yield* interruptAgent(h, session, owned)
          const still = execution !== undefined && (yield* sessionStore.openExecution(id)) === execution
          reasons.push(
            !stopped
              ? `it did not stop within ${Duration.format(STOP_WAIT)} of the interrupt key; its terminal closed anyway`
              : still
                ? `it did not confirm the interrupt within ${Duration.format(STOP_WAIT)}; its terminal closed anyway`
                : "it was working: interrupted, then its terminal closed",
          )
        }

        session = yield* getRow(id)
      }

      if (!archived(session)) {
        yield* sessionStore.archive(id)
        yield* dropQueue(session, "it was archived")

        session = yield* getRow(id)
      }

      yield* fs
        .remove(layout.sessionFolder(session.projectId, id), { recursive: true, force: true })
        .pipe(Effect.ignore)

      const notOurs =
        recorded === null
          ? undefined
          : owned === undefined
            ? ((yield* otherSessionAt(session, recorded.target)) ?? "a newer session was recorded at it")
            : exitedAt(session) !== null
              ? yield* otherSessionAt(session, recorded.target)
              : undefined

      if (notOurs !== undefined && recorded !== null)
        reasons.push(`terminal ${formatTerminal(h, recorded.target)} left open: ${notOurs}`)

      const out = yield* locks.withLock(directoryLock((yield* sessionStore.sessionDirectory(id)) ?? ""))(
        releaser.release({
          h,
          session,
          terminal: notOurs === undefined ? owned : undefined,
          keepWorktree: options.keepWorktree,
          reasons,
        }),
      )

      yield* recount(runtimeOf(session), session.projectId).pipe(Effect.ignore)

      return out
    })

  const archiveLocked = (id: string, options: { readonly keepWorktree?: boolean | undefined }) =>
    Effect.flatMap(getRow(id), (session) => terminalLocked(session)(archiveOwned(id, options)))

  const archive = Effect.fn("Archive.archive")(
    function* (id: string, options: { readonly keepWorktree?: boolean | undefined } = {}) {
      yield* getRow(id)

      return yield* Effect.acquireUseRelease(
        sessionLive.stop(id),
        ({ already }) =>
          Effect.gen(function* () {
            if (already) return yield* new SessionBusy({ id, message: `${id} is already being archived` })
            yield* starts.remove(id)

            return (yield* locked(id)(archiveLocked(id, options)))!
          }),
        ({ already }) => (already ? Effect.void : release(id)),
      )
    },
    Effect.catchTag("PlatformError", () => Effect.die(new Error("a platform error blocked an archive"))),
  )

  const stop = Effect.fn("Archive.stop")(function* (id: string, by: Sender, idleSince?: number) {
    const known = yield* getRow(id)

    return yield* locked(id)(
      Effect.gen(function* () {
        const session = yield* getRow(id)

        if (archived(session)) return yield* new NoSuchSession({ id, message: `${id} was archived` })

        if ((session.process === null || session.process.endedAt !== null) && (yield* starts.isWaiting(id)))
          return { stopped: false, message: `${id} has no process to stop because it is waiting to start` }

        if (exitedAt(session) !== null) return { stopped: false, message: `${id} is not running; a message resumes it` }
        const h = yield* live(session)
        const terminal = terminalOf(session)?.target

        if (terminal === undefined) return { stopped: false, message: `${id} is not running; a message resumes it` }
        const execution = yield* sessionStore.openExecution(id)
        const state = stateOf(yield* sessionState(h, terminal, Effect.succeed(session.status))) ?? "unknown"

        if (
          idleSince !== undefined &&
          (session.lastActive > idleSince ||
            execution !== undefined ||
            busy(state) ||
            (yield* inboxStore.waitingOn(id)))
        )
          return { stopped: false, message: `${id} is not idle; it keeps running` }
        const working = busy(state) || (yield* sessionStore.executionAccepted(id))
        const interrupted = working ? yield* interruptAgent(h, session, terminal) : false

        if (interrupted && execution !== undefined) yield* sessionStore.closeExecution(id, execution, "interrupted")

        const failed = yield* h.close(terminal).pipe(
          Effect.as(undefined),
          Effect.catchTag("RuntimeError", (error) => Effect.succeed(error.code === "not_found" ? undefined : error)),
        )

        if (failed?.code === "unreachable")
          return yield* new RuntimeUnreachable({ session: runtimeOf(session), message: failed.message })

        if (failed !== undefined)
          return yield* new SessionBusy({
            id,
            message: `closing its terminal failed: ${failed.message}; it still runs`,
          })

        if (execution !== undefined && !interrupted)
          yield* sessionStore.closeExecution(
            id,
            execution,
            (yield* sessionStore.executionAccepted(id)) ? "lost" : "not_started",
          )
        yield* sessionStore.stopProcess(id, by)
        yield* recount(runtimeOf(session), session.projectId).pipe(Effect.ignore)
        const before = working ? interruptNote(interrupted) : ""

        return {
          stopped: true,
          message: `${id} stopped: ${before}its terminal closed; its worktree, branch and messages are kept, and the next message resumes its conversation`,
        }
      }),
    ).pipe(
      Effect.catchTag("RuntimeError", (e) =>
        Effect.fail(new RuntimeUnreachable({ session: runtimeOf(known), message: e.message })),
      ),
    )
  })

  const finishArchive = Effect.fn("Archive.finishArchive")((id: string) =>
    locked(id)(
      Effect.gen(function* () {
        const session = yield* getRow(id)

        if (!archived(session) || exitedAt(session) !== null) return
        const h = yield* live(session)

        const out = yield* locks.withLock(directoryLock((yield* sessionStore.sessionDirectory(id)) ?? ""))(
          releaser.release({ h, session, terminal: terminalOf(session)?.target, keepWorktree: true, reasons: [] }),
        )

        yield* recount(runtimeOf(session), session.projectId).pipe(Effect.ignore)

        if (out.processes !== "exited")
          yield* notice(
            session,
            `${sessionLabel(session)} is archived, but ${out.pane === "kept" ? "its terminal could not be closed" : "its processes are not confirmed gone"}`,
          )
      }),
    ).pipe(logged(`archive ${id}`)),
  )

  return { undoCutOffStart, archive, stop, finishArchive }
})

export type Interface = Effect.Success<typeof make>

export class Service extends Context.Service<Service, Interface>()("vibest/Archive") {}

export const layer = Layer.effect(Service, make)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [
    SessionStore.node,
    InboxStore.node,
    Executions.node,
    Inbox.node,
    Placement.node,
    Starts.node,
    Processes.node,
    Runtimes.node,
    SessionLive.node,
    SessionLocks.node,
    Git.node,
    PlatformNode.fileSystem,
    PlatformNode.layout,
    PlatformNode.path,
  ],
})
