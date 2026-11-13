import { NoSuchSession, SessionBusy } from "@vibest/schema/session"
import { Cause, Context, Duration, Effect, FiberSet, FileSystem, Layer, Ref } from "effect"

import { Bus, type BusEvent } from "../bus.ts"
import {
  Db,
  type SessionRow,
  sessionEnded,
  runtimeOf,
  terminalOf,
  exitedAt,
  executionStateOf,
  archived,
} from "../db.ts"
import { Drain } from "../drain.ts"
import { LayerNode } from "../effect/layer-node.ts"
import * as PlatformNode from "../effect/platform.ts"
import * as Engine from "../engine.ts"
import { Inbox } from "../inbox.ts"
import { directoryLock } from "../keyed-lock.ts"
import { errorMessage } from "../plugins.ts"
import { Processes } from "../processes.ts"
import * as Remove from "../remove.ts"
import { agentState, Runtimes, type Runtime } from "../runtimes.ts"
import { Git } from "../worktree.ts"
import { busyOf, Executions, STOP_WAIT } from "./executions.ts"
import { SessionLive } from "./live.ts"
import { SessionLocks } from "./locks.ts"
import { Placement } from "./placement.ts"

const make = Effect.gen(function* () {
  const db = yield* Db
  const fs = yield* FileSystem.FileSystem
  const runtimes = yield* Runtimes
  const inbox = yield* Inbox
  const drain = yield* Drain
  const removal = yield* Remove.make
  const locks = yield* SessionLocks
  const sessionLive = yield* SessionLive
  const { notice, recount } = yield* Placement
  const { interruptAgent, settleAfterInterrupt } = yield* Executions
  const engine = yield* Engine.make
  const archives = yield* FiberSet.make()
  const { locked } = locks
  const logged = Engine.logFailure
  const live = (session: SessionRow) => runtimes.route(runtimeOf(session))
  const dropQueue = inbox.dropQueue
  const getRow = (id: string) =>
    db
      .getSession(id)
      .pipe(
        Effect.flatMap((session) =>
          session ? Effect.succeed(session) : Effect.fail(new NoSuchSession({ id, message: `no session ${id}` })),
        ),
      )

  const undoCutOffStart = Effect.fn("Archive.undoCutOffStart")(function* (h: Runtime, session: SessionRow) {
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

  const release = (id: string) =>
    db.getSession(id).pipe(Effect.flatMap((row) => sessionLive.release(id, sessionEnded(row))))

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
      const execution = yield* db.openExecution(id)
      if (working || execution !== undefined) {
        if (options.unlessPending) return undefined
        if (working) {
          const stopped = yield* interruptAgent(h, session, terminal)
          reasons.push(
            stopped
              ? `${id} was working: interrupted, then its terminal closed`
              : `${id} did not stop within ${Duration.format(STOP_WAIT)} of the interrupt key; its terminal closed anyway`,
          )
        }
        if (execution !== undefined) yield* db.closeExecution(id, execution, "interrupted")
        session = yield* getRow(id)
      }
      if (!archived(session)) {
        if (options.unlessPending) {
          if (!(yield* db.archiveIfNoPending(id))) return undefined
        } else {
          yield* db.archive(id)
          yield* dropQueue(session, `${id} was archived before it was delivered`)
        }
        session = yield* getRow(id)
      }
      const out = yield* locks.withLock(directoryLock((yield* db.sessionDirectory(id)) ?? ""))(
        removal.release({
          h,
          session,
          terminal: exitedAt(session) === null ? terminal : undefined,
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
      const owner = yield* db.getSession(id)
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
            const skip = (why: string) => tell(`${id} not archived (vibest run --archive-on-idle): ${why}`)
            if (executionStateOf(session) !== "completed") return yield* Ref.set(r.archiveTold, false)
            const h = yield* live(session)
            const terminal = terminalOf(session)
            const seen = yield* agentState(h, terminal)
            if (seen !== "absent") {
              const settled = yield* settleAfterInterrupt(h, session, terminal)
              if (!settled)
                return yield* skip(`it did not go idle within ${Duration.format(STOP_WAIT)}; run vibest archive ${id}`)
            }
            const out = yield* removeLocked(id, { unlessPending: true })
            if (!out) return
            const kept = out.reasons.length > 0 ? ` Kept because: ${out.reasons.join("; ")}.` : ""
            const again = out.processes === "exited" ? "" : ` Run vibest archive ${id} again to check.`
            if (kept || again)
              yield* notice(
                session,
                `${id} archived (vibest run --archive-on-idle): terminal ${out.pane}, worktree ${out.worktree} at ${out.path}, branch ${out.branch ?? "(none)"} kept.${kept}${again}`,
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
                            : notice(
                                session,
                                `${id} auto-archive failed: ${errorMessage(cause)}; run vibest archive ${id}`,
                              ),
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
        const out = yield* locks.withLock(directoryLock((yield* db.sessionDirectory(id)) ?? ""))(
          removal.release({ h, session, terminal: terminalOf(session), keepWorktree: true, reasons: [] }),
        )
        yield* recount(runtimeOf(session), session.projectId).pipe(Effect.ignore)
        if (out.processes !== "exited")
          yield* notice(
            session,
            `${id} was being archived when vibestd stopped: its terminal was ${out.pane === "kept" ? "not closed" : "closed"}, but its processes are ${out.processes === "alive" ? "still working in its worktree" : "not confirmed gone"}; run vibest archive ${id} again to check.`,
          )
      }),
    ).pipe(logged(`archive ${id}`)),
  )

  const archiveSoon = (ids: ReadonlyArray<string>) =>
    Effect.forEach(
      ids,
      (id) =>
        FiberSet.run(archives, drain.work(`archive ${id}`, archiveIfIdle(id).pipe(logged(`archive ${id}`)), true)),
      { discard: true },
    )

  const handle = (event: BusEvent): Effect.Effect<unknown, unknown> => {
    switch (event.type) {
      case "execution.ended":
        return event.data.outcome === "completed" ? archiveSoon([event.sessionId!]) : Effect.void
      case "inbox.moved":
        return event.data.to === "pending" || event.data.to === "delivering"
          ? Effect.void
          : db.inboxParties(event.sessionId!, event.data.inbox).pipe(Effect.flatMap(archiveSoon))
      case "session.ended":
        return db
          .creatorOf(event.sessionId!)
          .pipe(
            Effect.flatMap((creator) =>
              creator !== undefined && "local" in creator ? archiveSoon([creator.local]) : Effect.void,
            ),
          )
      default:
        return Effect.void
    }
  }

  yield* engine.on(handle)

  return { undoCutOffStart, remove, finishArchive }
})

export class Archive extends Context.Service<Archive, Effect.Success<typeof make>>()("vibest/Archive") {
  static readonly make = make

  static readonly layer = Layer.effect(Archive, make)

  static readonly node = LayerNode.make({
    service: Archive,
    layer: Archive.layer,
    deps: [
      Bus.node,
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
}
