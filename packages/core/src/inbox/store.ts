import { type Sender } from "@vibest/schema/event"
import { type InboxStatus } from "@vibest/schema/session"
import { LayerNode } from "@vibest/util/layer-node"
import { Clock, Context, Effect, Layer } from "effect"

import { Bus } from "../bus.ts"
import { Database } from "../database/database.ts"
import { type NewInboxRow } from "../database/rows.ts"
import { PlatformNode } from "../effect/platform.ts"
import { Projectors } from "../reactor.ts"
import { remoteSql } from "../remote/sql.ts"
import { nextBatch } from "../runtime/batch.ts"
import { SessionLive } from "../session/live.ts"
import { sessionSql } from "../session/sql.ts"
import { inboxSql } from "./sql.ts"

export * as InboxStore from "./store.ts"

export const make = Effect.gen(function* () {
  const { sql } = yield* Database.Service
  const { transaction: tx } = yield* Bus.Service
  const now = Clock.currentTimeMillis
  const session = yield* sessionSql
  const remote = yield* remoteSql
  const inbox = yield* inboxSql(session, remote)
  const { openExecution, startedAt, observable, fromOldProcess, allocateExecution } = session

  const {
    inbox: inboxWhere,
    inboxIn,
    findSend,
    untakenTask,
    moveInbox,
    confirm,
    confirmBatch,
    confirmTask,
    dropUnsent,
    queueSend,
    queuedFrom,
    liveRecipient,
    tellSender,
    insertInboxRow,
    waitingOn,
  } = inbox

  return {
    insertInbox: Effect.fn("InboxStore.insertInbox")((row: NewInboxRow) => tx(insertInboxRow(row)).pipe(Effect.orDie)),

    insertSend: Effect.fn("InboxStore.insertSend")(
      (recipient: string, message: string, sender: Sender = { type: "user" }, request?: string) =>
        tx(
          Effect.gen(function* () {
            const before = request === undefined ? undefined : yield* queuedFrom(sender, request)

            if (before !== undefined) return (yield* inboxIn(before.session, [before.id]))[0]

            if (!(yield* liveRecipient(recipient))) return undefined

            return yield* queueSend(recipient, sender, message, request)
          }),
        ).pipe(Effect.orDie),
    ),

    insertNoticeTo: Effect.fn("InboxStore.insertNoticeTo")((recipient: string, message: string) =>
      tx(tellSender(recipient, message)).pipe(Effect.orDie),
    ),

    sentIn: Effect.fn("InboxStore.sentIn")((sessionId: string, execution: number) =>
      sql<{ sent: number }>`SELECT
          (SELECT count(*) FROM inbox m
            WHERE m.sender_type = 'agent' AND m.sender_machine IS NULL
              AND m.sender_session_id = ${sessionId} AND m.sender_execution_id = ${execution}
              AND NOT EXISTS (SELECT 1 FROM session s WHERE s.id = m.recipient_session_id AND s.message_id = m.id))
          + (SELECT count(*) FROM outbox
            WHERE session_id = ${sessionId} AND kind = 'send' AND execution_id = ${execution}) AS sent`.pipe(
        Effect.map((rows) => rows[0]?.sent ?? 0),
        Effect.orDie,
      ),
    ),

    queuedFrom: Effect.fn("InboxStore.queuedFrom")((sender: Sender, request: string) =>
      queuedFrom(sender, request).pipe(
        Effect.map((row) => row !== undefined),
        Effect.orDie,
      ),
    ),

    maySend: Effect.fn("InboxStore.maySend")((sender: string, recipient: string, remoteId = "") =>
      (remoteId === ""
        ? sql`SELECT 1 FROM session_edge e JOIN session b ON b.id = e.to_session_id
            WHERE e.from_session_id = ${sender} AND e.to_remote_id = '' AND e.to_session_id = ${recipient}`
        : sql`SELECT 1 FROM session_edge e
            WHERE e.from_session_id = ${sender} AND e.to_remote_id = ${remoteId} AND e.to_session_id = ${recipient}`
      ).pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.orDie,
      ),
    ),

    linkTask: Effect.fn("InboxStore.linkTask")((id: string) =>
      tx(
        Effect.gen(function* () {
          const execution = yield* openExecution(id)

          if (execution !== undefined) yield* inbox.linkTask(id, execution, yield* now)
        }),
      ).pipe(Effect.orDie),
    ),

    untakenTask: Effect.fn("InboxStore.untakenTask")((id: string) => untakenTask(id).pipe(Effect.orDie)),

    waitingOn: Effect.fn("InboxStore.waitingOn")((id: string) => waitingOn(id).pipe(Effect.orDie)),

    hasQueued: Effect.fn("InboxStore.hasQueued")((id: string) =>
      sql<{
        id: number
      }>`SELECT id FROM inbox WHERE recipient_session_id = ${id} AND status = 'pending' LIMIT 1`.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.orDie,
      ),
    ),

    pendingRecipients: Effect.fn("InboxStore.pendingRecipients")(() =>
      sql<{ id: string }>`SELECT DISTINCT recipient_session_id AS id FROM inbox WHERE status = 'pending'`.pipe(
        Effect.map((rows) => rows.map((row) => row.id)),
        Effect.orDie,
      ),
    ),

    pendingInbox: Effect.fn("InboxStore.pendingInbox")((sessionId: string) =>
      findSend(sessionId, "pending").pipe(Effect.orDie),
    ),

    inboxWithStatus: Effect.fn("InboxStore.inboxWithStatus")((sessionId: string, status: InboxStatus) =>
      findSend(sessionId, status).pipe(Effect.orDie),
    ),

    deliveringInbox: inboxWhere(sql`m.status = 'delivering'`).pipe(
      Effect.map((rows) => rows.map((r) => ({ id: r.id, sessionId: r.recipient ?? "" }))),
      Effect.orDie,
    ),

    claim: Effect.fn("InboxStore.claim")((sessionId: string, ids: ReadonlyArray<number>, execution?: number) =>
      Effect.gen(function* () {
        if (ids.length === 0) return []

        const claimed = yield* moveInbox(
          sql`recipient_session_id = ${sessionId} AND ${sql.in("id", ids)} AND status = 'pending'`,
          "delivering",
          execution === undefined ? undefined : { execution },
        )

        return claimed.map((k) => k.id)
      }).pipe(Effect.orDie),
    ),

    confirm: Effect.fn("InboxStore.confirm")((sessionId: string, execution: number) =>
      confirm(sessionId, execution).pipe(Effect.asVoid, Effect.orDie),
    ),

    confirmBatch: Effect.fn("InboxStore.confirmBatch")(
      (sessionId: string, execution: number, ids: ReadonlyArray<number>) =>
        confirmBatch(sessionId, execution, ids).pipe(Effect.asVoid, Effect.orDie),
    ),

    confirmTask: Effect.fn("InboxStore.confirmTask")((sessionId: string, execution: number) =>
      confirmTask(sessionId, execution).pipe(Effect.asVoid, Effect.orDie),
    ),

    dropUnsent: Effect.fn("InboxStore.dropUnsent")((sessionId: string, reason: string) =>
      dropUnsent(sessionId, reason).pipe(Effect.asVoid, Effect.orDie),
    ),

    unsentDelegation: Effect.fn("InboxStore.unsentDelegation")((sessionId: string) =>
      inboxWhere(
        sql`m.recipient_session_id = ${sessionId} AND m.status IN ('pending', 'delivering')
          AND m.id = (SELECT message_id FROM session WHERE id = ${sessionId})`,
      ).pipe(Effect.orDie),
    ),

    unacceptedBatch: Effect.fn("InboxStore.unacceptedBatch")((sessionId: string, execution: number) =>
      tx(
        Effect.gen(function* () {
          if ((yield* openExecution(sessionId)) !== execution || (yield* startedAt(sessionId, execution)) !== null)
            return undefined

          return yield* inboxWhere(
            sql`m.recipient_session_id = ${sessionId} AND m.status = 'delivering' AND m.recipient_execution_id = ${execution}`,
          )
        }),
      ).pipe(Effect.orDie),
    ),

    hasUnacceptedPulledBatch: Effect.fn("InboxStore.hasUnacceptedPulledBatch")((sessionId: string, execution: number) =>
      sql<{ ok: number }>`SELECT 1 AS ok FROM inbox m
            WHERE m.recipient_session_id = ${sessionId} AND m.status = 'delivering'
              AND m.recipient_execution_id = ${execution}
              AND NOT EXISTS (SELECT 1 FROM session s WHERE s.id = m.recipient_session_id AND s.message_id = m.id)
            LIMIT 1`.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.orDie,
      ),
    ),

    deliveredIn: Effect.fn("InboxStore.deliveredIn")((sessionId: string, execution: number) =>
      inboxWhere(
        sql`m.recipient_session_id = ${sessionId} AND m.status = 'delivered' AND m.recipient_execution_id = ${execution}
          AND NOT EXISTS (SELECT 1 FROM session s WHERE s.id = m.recipient_session_id AND s.message_id = m.id)`,
      ).pipe(Effect.orDie),
    ),

    takeInbox: Effect.fn("InboxStore.takeInbox")((sessionId: string, process: number | undefined) =>
      tx(
        Effect.gen(function* () {
          if (!(yield* observable(sessionId)) || (yield* fromOldProcess(sessionId, process))) return undefined

          if ((yield* openExecution(sessionId)) !== undefined) return undefined
          const pending = yield* findSend(sessionId, "pending")

          if (pending.length === 0) return undefined
          const batch = nextBatch(pending)
          const execution = yield* allocateExecution(sessionId, yield* now)
          yield* moveInbox(
            sql`recipient_session_id = ${sessionId} AND ${sql.in(
              "id",
              batch.map((r) => r.id),
            )}`,
            "delivering",
            { execution },
          )

          return { execution, rows: batch }
        }),
      ).pipe(Effect.orDie),
    ),

    setInboxStatus: Effect.fn("InboxStore.setInboxStatus")(
      (
        sessionId: string,
        ids: ReadonlyArray<number>,
        status: "delivering" | "delivered" | "failed" | "dropped",
        from?: InboxStatus,
        into?: number,
        reason?: string,
      ) =>
        Effect.gen(function* () {
          if (ids.length === 0) return []

          const moved = yield* moveInbox(
            sql`recipient_session_id = ${sessionId} AND ${sql.in("id", ids)}${from ? sql` AND status = ${from}` : sql``}`,
            status,
            { ...(into !== undefined && { execution: into }), ...(reason !== undefined && { reason }) },
          )

          return moved.length === 0
            ? []
            : yield* inboxIn(
                sessionId,
                moved.map((k) => k.id),
              )
        }).pipe(Effect.orDie),
    ),

    latestInbox: Effect.fn("InboxStore.latestInbox")((sessionId: string, which: "send" | "notice") =>
      (which === "send"
        ? inboxWhere(
            sql`m.recipient_session_id = ${sessionId} AND m.sender_type != 'vibest' AND NOT EXISTS (SELECT 1 FROM session s WHERE s.id = m.recipient_session_id AND s.message_id = m.id)`,
            sql`m.id DESC LIMIT 1`,
          )
        : inboxWhere(sql`m.sender_type = 'vibest' AND m.about_session_id = ${sessionId}`, sql`m.id DESC LIMIT 1`)
      ).pipe(
        Effect.map((rows) => rows[0]),
        Effect.orDie,
      ),
    ),
  }
})

export type Interface = Effect.Success<typeof make>

export class Service extends Context.Service<Service, Interface>()("vibest/InboxStore") {}

export const layer = Layer.effect(Service, make)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Database.node, Bus.node, Projectors.node, SessionLive.node, PlatformNode.sqlClient],
})
