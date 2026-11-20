import { sessionLabel } from "@vibest/schema/id"
import { Layout } from "@vibest/schema/layout"
import { NoSuchSession, SessionBusy } from "@vibest/schema/session"
import { Cause, Context, Duration, Effect, FiberSet, FileSystem, Layer, Ref } from "effect"

import {
  type SessionRow,
  sessionEnded,
  runtimeOf,
  terminalOf,
  exitedAt,
  executionStateOf,
  archived,
} from "../database/db-rows.ts"
import { Db } from "../database/db.ts"
import { Drain } from "../drain.ts"
import { LayerNode } from "../effect/layer-node.ts"
import { PlatformNode } from "../effect/platform.ts"
import { Git } from "../git.ts"
import { Inbox } from "../inbox.ts"
import { errorMessage } from "../plugin.ts"
import { Processes } from "../processes.ts"
import * as Reactor from "../reactor.ts"
import * as Remove from "../remove.ts"
import { agentState, Runtimes, type Runtime, type Terminal } from "../runtimes.ts"
import { busyOf, Executions, STOP_WAIT } from "./executions.ts"
import { SessionLive } from "./live.ts"
import { directoryLock, SessionLocks } from "./locks.ts"
import { Placement } from "./placement.ts"

export * as Archive from "./archive.ts"

export const make = Effect.gen(function* () {
  const db = yield* Db.Service
  const fs = yield* FileSystem.FileSystem
  const layout = yield* Layout
  const runtimes = yield* Runtimes.Service
  const inbox = yield* Inbox.Service
  const drain = yield* Drain.Service
  const removal = yield* Remove.make
  const locks = yield* SessionLocks.Service
  const sessionLive = yield* SessionLive.Service
  const { notice, recount } = yield* Placement.Service
  const { interruptAgent, settleAfterInterrupt } = yield* Executions.Service
  const archives = yield* FiberSet.make()
  const { locked } = locks
  const logged = Reactor.logFailure
  const live = (session: SessionRow) => runtimes.route(runtimeOf(session))
  const dropQueue = inbox.dropQueue

  const getRow = (id: string) =>
    db.session
      .getSession(id)
      .pipe(
        Effect.flatMap((session) =>
          session ? Effect.succeed(session) : Effect.fail(new NoSuchSession({ id, message: `no session ${id}` })),
        ),
      )

  const undoCutOffStart = Effect.fn("Archive.undoCutOffStart")(function* (h: Runtime, session: SessionRow) {
    const what = `${sessionLabel(session)} never finished starting (vibestd stopped while it started)`

    if (yield* db.session.hadTerminal(session.id)) return yield* notice(session, `${what}.`)
    const ended = yield* getRow(session.id)

    const out = yield* locks.withLock(directoryLock((yield* db.session.sessionDirectory(session.id)) ?? ""))(
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

  const leftOpenBecause = (h: Runtime, session: SessionRow, terminal: Terminal) =>
    Effect.gen(function* () {
      const others = (yield* db.session.processesAt(runtimeOf(session), terminal)).filter(
        (p) => p.sessionId !== session.id,
      )

      if (others.length > 0) return `session ${others.map((p) => p.sessionId).join(", ")} runs in it`

      return yield* h.process(terminal).pipe(
        Effect.map((p) => (p.running ? "a program other than its shell runs in it" : undefined)),
        Effect.catchTag("RuntimeError", (error) =>
          Effect.succeed(
            error.code === "not_found" ? undefined : `vibest could not tell what runs in it: ${error.message}`,
          ),
        ),
      )
    })

  const release = (id: string) =>
    db.session.getSession(id).pipe(Effect.flatMap((row) => sessionLive.release(id, sessionEnded(row))))

  const removeLocked = (
    id: string,
    options: { readonly keepWorktree?: boolean | undefined; readonly unlessPending?: boolean },
  ) =>
    Effect.gen(function* () {
      let session = yield* getRow(id)
      const h = yield* live(session)
      const terminal = terminalOf(session)
      const seen = yield* agentState(h, terminal)
      const reasons: Array<string> = []
      const working = busyOf(seen)
      const execution = yield* db.session.openExecution(id)

      if (working || execution !== undefined) {
        if (options.unlessPending) return undefined

        if (working) {
          const stopped = yield* interruptAgent(h, session, terminal)
          reasons.push(
            stopped
              ? "it was working: interrupted, then its terminal closed"
              : `it did not stop within ${Duration.format(STOP_WAIT)} of the interrupt key; its terminal closed anyway`,
          )
        }

        if (execution !== undefined) yield* db.session.closeExecution(id, execution, "interrupted")
        session = yield* getRow(id)
      }

      if (!archived(session)) {
        if (options.unlessPending) {
          if (!(yield* db.session.archiveIfNoPending(id))) return undefined
        } else {
          yield* db.session.archive(id)
          yield* dropQueue(session, "it was archived")
        }

        session = yield* getRow(id)
      }

      yield* fs
        .remove(layout.sessionFolder(session.projectId, id), { recursive: true, force: true })
        .pipe(Effect.ignore)

      const notOurs =
        exitedAt(session) !== null && terminal.id !== "" ? yield* leftOpenBecause(h, session, terminal) : undefined

      if (notOurs !== undefined) reasons.push(`terminal ${terminal.id} left open: ${notOurs}`)

      const out = yield* locks.withLock(directoryLock((yield* db.session.sessionDirectory(id)) ?? ""))(
        removal.release({
          h,
          session,
          terminal: notOurs === undefined ? terminal : undefined,
          keepWorktree: options.keepWorktree,
          reasons,
        }),
      )

      yield* recount(runtimeOf(session), session.projectId).pipe(Effect.ignore)

      return out
    })

  const remove = Effect.fn("Archive.remove")(
    function* (id: string, options: { readonly keepWorktree?: boolean | undefined } = {}) {
      yield* getRow(id)
      const { already } = yield* sessionLive.stop(id)

      if (already) return yield* new SessionBusy({ id, message: `${id} is already being removed` })
      const out = (yield* locked(id)(removeLocked(id, options)).pipe(Effect.ensuring(release(id))))!

      return out
    },
    Effect.catchTag("PlatformError", () => Effect.die(new Error("a platform error blocked a remove"))),
  )

  const archiveIfIdle = (id: string) =>
    Effect.gen(function* () {
      if (!(yield* sessionLive.archivesOnIdle(id))) return
      const owner = yield* db.session.getSession(id)

      if (owner === undefined || archived(owner)) return
      yield* locked(
        id,
        true,
      )(
        Effect.gen(function* () {
          const r = yield* sessionLive.track(id)

          if (yield* Ref.getAndSet(r.stopping, true)) return
          yield* Effect.gen(function* () {
            const session = yield* getRow(id)

            if (archived(session)) return

            const tell = (message: string) =>
              Ref.getAndSet(r.archiveTold, true).pipe(
                Effect.flatMap((told) => (told ? Effect.void : notice(session, message))),
              )

            const skip = (why: string) => tell(`${sessionLabel(session)} not archived (--archive-on-idle): ${why}`)

            if (executionStateOf(session) !== "completed") return yield* Ref.set(r.archiveTold, false)
            const h = yield* live(session)
            const terminal = terminalOf(session)
            const seen = yield* agentState(h, terminal)

            if (seen !== "absent") {
              const settled = yield* settleAfterInterrupt(h, session, terminal)

              if (!settled) return yield* skip(`it did not go idle within ${Duration.format(STOP_WAIT)}`)
            }

            const out = yield* removeLocked(id, { unlessPending: true })

            if (!out) return
            const kept = out.reasons.length > 0 ? ` Kept because: ${out.reasons.join("; ")}.` : ""
            const unconfirmed = out.processes === "exited" ? "" : " Its processes are not confirmed gone."

            if (kept || unconfirmed)
              yield* notice(
                session,
                `${sessionLabel(session)} archived (--archive-on-idle): terminal ${out.pane}, worktree ${out.worktree} at ${out.path}, branch ${out.branch ?? "(none)"} kept.${kept}${unconfirmed}`,
              )
          }).pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.failCause(cause)
                : getRow(id).pipe(
                    Effect.flatMap((session) =>
                      Ref.getAndSet(r.archiveTold, true).pipe(
                        Effect.flatMap((told) =>
                          told
                            ? Effect.void
                            : notice(session, `${sessionLabel(session)} auto-archive failed: ${errorMessage(cause)}`),
                        ),
                      ),
                    ),
                  ),
            ),
            Effect.ensuring(release(id)),
          )
        }),
      )
    })

  const finishArchive = Effect.fn("Archive.finishArchive")((id: string) =>
    locked(id)(
      Effect.gen(function* () {
        const session = yield* getRow(id)

        if (!archived(session) || exitedAt(session) !== null) return
        const h = yield* live(session)

        const out = yield* locks.withLock(directoryLock((yield* db.session.sessionDirectory(id)) ?? ""))(
          removal.release({ h, session, terminal: terminalOf(session), keepWorktree: true, reasons: [] }),
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

  const archiveSoon = Effect.fn("Archive.archiveSoon")((ids: ReadonlyArray<string>) =>
    Effect.forEach(
      ids,
      (id) =>
        FiberSet.run(archives, drain.work(`archive ${id}`, archiveIfIdle(id).pipe(logged(`archive ${id}`)), true)),
      { discard: true },
    ),
  )

  return { undoCutOffStart, remove, finishArchive, archiveSoon }
})

export type Interface = Effect.Success<typeof make>

export class Service extends Context.Service<Service, Interface>()("vibest/Archive") {}

export const layer = Layer.effect(Service, make)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [
    Db.node,
    Drain.node,
    Executions.node,
    Inbox.node,
    Placement.node,
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

export const archiveOnIdle = Effect.gen(function* () {
  const archive = yield* Service
  const db = yield* Db.Service
  const live = yield* SessionLive.Service

  return {
    optedIn: live.archivesOnIdle,
    consider: archive.archiveSoon,
    parties: (sessionId: string, inbox: number) => db.inbox.inboxParties(sessionId, inbox),
    localCreator: (sessionId: string) =>
      db.session
        .creatorOf(sessionId)
        .pipe(Effect.map((creator) => (creator !== undefined && "local" in creator ? creator.local : undefined))),
  }
})
