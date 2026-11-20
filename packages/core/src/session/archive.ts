import { sessionLabel } from "@vibest/schema/id"
import { Layout } from "@vibest/schema/layout"
import { NoSuchSession, SessionBusy } from "@vibest/schema/session"
import { Context, Duration, Effect, FileSystem, Layer } from "effect"

import { type SessionRow, sessionEnded, runtimeOf, terminalOf, exitedAt, archived } from "../database/db-rows.ts"
import { Db } from "../database/db.ts"
import { LayerNode } from "../effect/layer-node.ts"
import { PlatformNode } from "../effect/platform.ts"
import { Git } from "../git.ts"
import { Inbox } from "../inbox.ts"
import { Processes } from "../processes.ts"
import * as Reactor from "../reactor.ts"
import * as Remove from "../remove.ts"
import { agentState, Runtimes, type Runtime, type Terminal } from "../runtimes.ts"
import { busyOf, Executions, STOP_WAIT } from "./executions.ts"
import { SessionLive } from "./live.ts"
import { directoryLock, SessionLocks } from "./locks.ts"
import { Placement } from "./placement.ts"
import { Starts } from "./starts.ts"

export * as Archive from "./archive.ts"

export const make = Effect.gen(function* () {
  const db = yield* Db.Service
  const fs = yield* FileSystem.FileSystem
  const layout = yield* Layout
  const runtimes = yield* Runtimes.Service
  const inbox = yield* Inbox.Service
  const removal = yield* Remove.make
  const locks = yield* SessionLocks.Service
  const sessionLive = yield* SessionLive.Service
  const { notice, recount } = yield* Placement.Service
  const starts = yield* Starts.Service
  const { interruptAgent } = yield* Executions.Service
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

  const otherSessionAt = (session: SessionRow, terminal: Terminal) =>
    db.session.processesAt(runtimeOf(session), terminal).pipe(
      Effect.map((processes) => {
        const others = processes.filter((p) => p.sessionId !== session.id).map((p) => p.sessionId)

        return others.length > 0 ? `session ${others.join(", ")} runs in it` : undefined
      }),
    )

  const release = (id: string) =>
    db.session.getSession(id).pipe(Effect.flatMap((row) => sessionLive.release(id, sessionEnded(row))))

  const removeLocked = (id: string, options: { readonly keepWorktree?: boolean | undefined }) =>
    Effect.gen(function* () {
      let session = yield* getRow(id)
      const h = session.process === null ? undefined : yield* live(session)
      const terminal = terminalOf(session)
      const seen = h === undefined ? ("absent" as const) : yield* agentState(h, terminal)
      const reasons: Array<string> = []
      const working = busyOf(seen)
      const execution = yield* db.session.openExecution(id)

      if (working || execution !== undefined) {
        if (working && h !== undefined) {
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
        yield* db.session.archive(id)
        yield* dropQueue(session, "it was archived")

        session = yield* getRow(id)
      }

      yield* fs
        .remove(layout.sessionFolder(session.projectId, id), { recursive: true, force: true })
        .pipe(Effect.ignore)

      const notOurs =
        exitedAt(session) !== null && terminal.id !== "" ? yield* otherSessionAt(session, terminal) : undefined

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

      return yield* Effect.acquireUseRelease(
        sessionLive.stop(id),
        ({ already }) =>
          Effect.gen(function* () {
            if (already) return yield* new SessionBusy({ id, message: `${id} is already being removed` })
            yield* starts.remove(id)

            return (yield* locked(id)(removeLocked(id, options)))!
          }),
        ({ already }) => (already ? Effect.void : release(id)),
      )
    },
    Effect.catchTag("PlatformError", () => Effect.die(new Error("a platform error blocked a remove"))),
  )

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

  return { undoCutOffStart, remove, finishArchive }
})

export type Interface = Effect.Success<typeof make>

export class Service extends Context.Service<Service, Interface>()("vibest/Archive") {}

export const layer = Layer.effect(Service, make)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [
    Db.node,
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
