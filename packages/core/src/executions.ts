import type { HarnessUnavailable, NotReady } from "@vibest/schema/session"
import { Clock, Effect, Exit } from "effect"
import type { FileSystem, Path } from "effect"

import { type InboxRow, type InboxStatus, type SessionPatch, type SessionRow, type ExecutionEnd } from "./db.ts"
import { nextBatch } from "./inbox.ts"
import { type Runtime, type RuntimeError, type Terminal } from "./runtimes.ts"

export const sessionExecutions = (deps: {
  readonly db: {
    readonly endExecution: (
      id: string,
      end: ExecutionEnd,
      patch: SessionPatch,
      notice: string | undefined,
      at?: number,
    ) => Effect.Effect<void>
    readonly pendingInbox: (sessionId: string) => Effect.Effect<ReadonlyArray<InboxRow>>
    readonly claim: (sessionId: string, ids: ReadonlyArray<number>) => Effect.Effect<ReadonlyArray<number>>
    readonly setInboxStatus: (
      sessionId: string,
      ids: ReadonlyArray<number>,
      status: InboxStatus,
      from?: InboxStatus,
      into?: number,
    ) => Effect.Effect<ReadonlyArray<InboxRow>>
    readonly openExecution: (sessionId: string) => Effect.Effect<number | undefined>
    readonly untakenTask: (sessionId: string) => Effect.Effect<string | undefined>
  }
  readonly undelivered: (
    session: SessionRow,
    rows: ReadonlyArray<{
      readonly id: number
      readonly message: string
      readonly kind?: string
      readonly sender?: string | null
    }>,
    reason: string,
  ) => Effect.Effect<unknown>
  readonly prompt: (
    h: Runtime,
    session: SessionRow,
    terminal: Terminal,
    text: string,
    onHandover?: Effect.Effect<void>,
  ) => Effect.Effect<string | undefined, NotReady | RuntimeError | HarnessUnavailable, FileSystem.FileSystem>
  readonly handTask: (
    h: Runtime,
    session: SessionRow,
    terminal: Terminal,
    task: string,
  ) => Effect.Effect<void, NotReady | RuntimeError | HarnessUnavailable, FileSystem.FileSystem | Path.Path>
}) => {
  const { db } = deps

  const finish = Effect.fn("Sessions.finish")(function* (session: SessionRow, end: "failed", error: string) {
    yield* db.endExecution(
      session.id,
      { outcome: end, failure: { message: error } },
      { executionState: end, lastActive: yield* Clock.currentTimeMillis },
      `${session.id}'s execution ended with an error: ${error}`,
    )
  })

  const deliverQueued = Effect.fn("Sessions.deliverQueued")(function* (
    h: Runtime,
    session: SessionRow,
    terminal: Terminal,
  ) {
    const task = yield* db.untakenTask(session.id)
    if (task !== undefined) return yield* deps.handTask(h, session, terminal, task)
    const pending = yield* db.pendingInbox(session.id)
    if (pending.length === 0) return
    const batch = nextBatch(pending)
    const ids = batch.map((r) => r.id)
    const claimed: Array<number> = []
    let handedInto: number | undefined
    yield* deps
      .prompt(
        h,
        session,
        terminal,
        batch.map((r) => r.message).join("\n\n"),
        Effect.flatMap(db.openExecution(session.id), (execution) =>
          db.claim(session.id, ids).pipe(
            Effect.tap((got) =>
              Effect.sync(() => {
                claimed.push(...got)
                handedInto = execution
              }),
            ),
          ),
        ),
      )
      .pipe(
        Effect.flatMap((notStarted) => {
          const rows = batch.filter((r) => claimed.includes(r.id))
          if (rows.length === 0) return Effect.void
          return notStarted
            ? deps.undelivered(session, rows, notStarted)
            : db.setInboxStatus(session.id, claimed, "delivered", "delivering", handedInto)
        }),
        Effect.onExit((exit) =>
          Exit.isSuccess(exit) || claimed.length === 0
            ? Effect.void
            : db.setInboxStatus(session.id, claimed, "failed", "delivering"),
        ),
        Effect.catchTags({
          RuntimeError: (e) =>
            e.code === "unreachable"
              ? db.pendingInbox(session.id).pipe(
                  Effect.flatMap((pending) =>
                    pending.some((r) => claimed.includes(r.id))
                      ? Effect.fail(e)
                      : deps.undelivered(
                          session,
                          batch.filter((r) => claimed.includes(r.id)),
                          `the connection to ${session.runtime} broke after the message was handed over (${e.message}); it may have reached the session`,
                        ),
                  ),
                )
              : deps.undelivered(
                  session,
                  batch.filter((r) => claimed.includes(r.id)),
                  e.message,
                ),
          NotReady: (e) => {
            const rows = batch.filter((r) => claimed.includes(r.id))
            if (rows.length > 0) return deps.undelivered(session, rows, e.message)
            return db
              .pendingInbox(session.id)
              .pipe(
                Effect.flatMap((pending) =>
                  ids.some((id) => pending.some((r) => r.id === id)) ? Effect.fail(e) : Effect.void,
                ),
              )
          },
        }),
      )
  })

  return { finish, deliverQueued }
}
