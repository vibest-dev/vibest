import { NoSuchSession, SessionBusy } from "@vibest/schema/session"
import { Cause, Context, Duration, Effect, FileSystem, Ref } from "effect"

import { type Db, type SessionRow, sessionEnded } from "./db.ts"
import { directoryLock, type keyedLock } from "./keyed-lock.ts"
import type { sessionPlacement } from "./placement.ts"
import { errorMessage } from "./plugins.ts"
import { type sessionPrompting, STOP_WAIT } from "./prompting.ts"
import type * as Remove from "./remove.ts"
import { agentState, type Runtimes, type Runtime, type AgentSeen } from "./runtimes.ts"
import type { Platform } from "./session-types.ts"
import type { SessionLive } from "./session/live.ts"

export const sessionArchive = (deps: {
  readonly db: Db["Service"]
  readonly fs: FileSystem.FileSystem
  readonly removal: Effect.Success<typeof Remove.make>
  readonly locks: ReturnType<typeof keyedLock<string>>
  readonly platform: Context.Context<Platform>
  readonly getRow: (id: string) => Effect.Effect<SessionRow, NoSuchSession>
  readonly live: (session: SessionRow) => ReturnType<Runtimes["Service"]["route"]>
  readonly notice: (session: SessionRow, message: string) => Effect.Effect<unknown>
  readonly dropQueue: (session: SessionRow, reason: string) => Effect.Effect<unknown>
  readonly recount: ReturnType<typeof sessionPlacement>["recount"]
  readonly sessionLive: SessionLive["Service"]
  readonly locked: (
    id: string,
    settlement?: boolean,
  ) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  readonly logged: (what: string) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<void | A, never, R>
  readonly busyOf: (seen: AgentSeen) => boolean
  readonly interruptAgent: ReturnType<typeof sessionPrompting>["interruptAgent"]
  readonly settleAfterInterrupt: ReturnType<typeof sessionPrompting>["settleAfterInterrupt"]
}) => {
  const {
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
  } = deps
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

  const release = (id: string) =>
    db.getSession(id).pipe(Effect.flatMap((row) => sessionLive.release(id, sessionEnded(row))))

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
      if (!(session.metadata.archived || session.metadata.removed)) {
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
      const { already } = yield* sessionLive.stop(id)
      if (already) return yield* new SessionBusy({ id, message: `${id} is already being removed` })
      const out = (yield* locked(id)(removeLocked(id, options)).pipe(Effect.ensuring(release(id))))!
      return out
    }).pipe(
      Effect.catchTag("PlatformError", () => Effect.die(new Error("a platform error blocked a remove"))),
      Effect.provideContext(platform),
    )

  const archiveIfIdle = (id: string) =>
    Effect.gen(function* () {
      if (!(yield* sessionLive.archivesOnIdle(id))) return
      const owner = yield* db.getSession(id)
      if (owner === undefined || owner.metadata.archived || owner.metadata.removed) return
      yield* locked(
        id,
        true,
      )(
        Effect.gen(function* () {
          const r = yield* sessionLive.track(id)
          if (yield* Ref.getAndSet(r.stopping, true)) return
          yield* Effect.gen(function* () {
            const session = yield* getRow(id)
            if (session.metadata.archived || session.metadata.removed) return
            const tell = (message: string) =>
              Ref.getAndSet(r.archiveTold, true).pipe(
                Effect.flatMap((told) => (told ? Effect.void : notice(session, message))),
              )
            const skip = (why: string) => tell(`${id} not archived (vibest run --archive-on-idle): ${why}`)
            if (session.executionState !== "completed") return yield* Ref.set(r.archiveTold, false)
            const h = yield* live(session)
            const terminal = session.address
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

  return { undoCutOffStart, remove, archiveIfIdle, finishArchive }
}
