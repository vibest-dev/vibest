import { type Sender } from "@vibest/schema/event"
import { InboxRow, type InboxStatus } from "@vibest/schema/session"
import { SessionEvent } from "@vibest/schema/session-event"
import { Clock, Effect, Schema } from "effect"
import type { SqlClient, Statement } from "effect/sql"

import type { Bus } from "../bus.ts"
import {
  type InboxSql as InboxColumns,
  localSessionOf,
  type NewInboxRow,
  senderKey,
  toInbox,
} from "../database/rows.ts"
import { queueForRemote, senderOf } from "../remote/sql.ts"
import { envelopeFrom, noticeEnvelope } from "../session/replies.ts"
import { isLiveSession, nearestAlive, openExecution } from "../session/sql.ts"

type InboxKey = { readonly session: string; readonly id: number }

const decodeInbox = Schema.decodeUnknownEffect(Schema.Array(InboxRow))

export const inboxWhere = (
  sql: SqlClient.SqlClient,
  where: Statement.Fragment,
  order: Statement.Fragment = sql`m.id`,
) =>
  sql<InboxColumns>`SELECT m.id, m.recipient_session_id AS session_id, m.sender_type, m.sender_session_id, m.sender_agent, m.sender_title,
      m.sender_machine, m.sender_plugin, m.content, m.status
    FROM inbox m WHERE ${where} ORDER BY ${order}`.pipe(Effect.flatMap((rows) => decodeInbox(rows.map(toInbox))))

export const inboxIn = (sql: SqlClient.SqlClient, recipient: string, ids: ReadonlyArray<number>) =>
  inboxWhere(sql, sql`m.recipient_session_id = ${recipient} AND ${sql.in("m.id", ids)}`)

export const findSend = (sql: SqlClient.SqlClient, sessionId: string, status: InboxStatus) => {
  const notDelegation = sql`NOT EXISTS (SELECT 1 FROM session s WHERE s.id = m.recipient_session_id AND s.message_id = m.id)`

  return inboxWhere(sql, sql`m.recipient_session_id = ${sessionId} AND m.status = ${status} AND ${notDelegation}`)
}

export const untakenTask = (sql: SqlClient.SqlClient, id: string) =>
  sql<{ id: number; content: string }>`SELECT i.id, i.content FROM inbox i
    JOIN session s ON s.id = i.recipient_session_id AND s.message_id = i.id
    WHERE i.recipient_session_id = ${id} AND i.status = 'pending' AND i.recipient_execution_id IS NULL
    LIMIT 1`.pipe(Effect.map((rows) => rows[0]))

export const moveInbox = (
  sql: SqlClient.SqlClient,
  bus: Bus.Interface,
  where: Statement.Fragment,
  to: "delivering" | "delivered" | "failed" | "dropped",
  detail?: { readonly execution?: number; readonly reason?: string },
) =>
  bus.transaction(
    Effect.gen(function* () {
      const rows = yield* sql<{
        id: number
        status: string
        session: string
      }>`SELECT id, status, recipient_session_id AS session FROM inbox WHERE ${where} ORDER BY recipient_session_id, id`

      const moved = rows.filter((r) => r.status !== to)
      const at = yield* Clock.currentTimeMillis

      for (const r of moved) {
        if (to === "delivering") {
          yield* bus.publish(
            SessionEvent.InboxDelivering,
            {
              sessionId: r.session,
              messageId: r.id,
              ...(detail?.execution !== undefined && { execution: detail.execution }),
            },
            { at },
          )
          continue
        }

        if (to === "delivered") {
          const execution = detail?.execution ?? (yield* openExecution(sql, r.session))

          if (execution === undefined)
            return yield* Effect.die(new Error(`inbox ${r.session} ${r.id} delivered without an execution`))
          yield* bus.publish(
            SessionEvent.InboxDelivered,
            { sessionId: r.session, messageId: r.id, recipientExecutionId: execution },
            { at },
          )
          continue
        }

        const reason = detail?.reason

        if (reason === undefined)
          return yield* Effect.die(new Error(`inbox ${r.session} ${r.id} ${to} without a reason`))
        yield* bus.publish(
          to === "failed" ? SessionEvent.InboxFailed : SessionEvent.InboxDropped,
          { sessionId: r.session, messageId: r.id, reason },
          { at },
        )
      }

      return moved.map((r): InboxKey => ({ session: r.session, id: r.id }))
    }),
  )

const nextMessageId = (sql: SqlClient.SqlClient, sessionId: string) =>
  sql<{ id: number }>`SELECT coalesce(max(id), 0) + 1 AS id FROM inbox
    WHERE recipient_session_id = ${sessionId}`.pipe(Effect.map((rows) => rows[0]?.id ?? 1))

export const queueInbox = (
  sql: SqlClient.SqlClient,
  publish: Bus.Interface["publish"],
  row: {
    readonly recipient: string
    readonly sender: Sender
    readonly about?: string | undefined
    readonly content: string
    readonly request?: string | undefined
    readonly transfer?: string | undefined
    readonly senderExecution?: number | undefined
    readonly at?: number | undefined
  },
) =>
  Effect.gen(function* () {
    const messageId = yield* nextMessageId(sql, row.recipient)
    yield* publish(
      SessionEvent.InboxEnqueued,
      {
        sessionId: row.recipient,
        messageId,
        sender: row.sender,
        content: row.content,
        ...(row.about !== undefined && { aboutSessionId: row.about }),
        ...(row.request !== undefined && { requestId: row.request }),
        ...(row.transfer !== undefined && { transferId: row.transfer }),
        ...(row.senderExecution !== undefined && { senderExecutionId: row.senderExecution }),
      },
      row.at === undefined ? undefined : { at: row.at },
    )

    return messageId
  })

export const linkTask = (
  sql: SqlClient.SqlClient,
  publish: Bus.Interface["publish"],
  sessionId: string,
  execution: number,
  at: number,
) =>
  Effect.gen(function* () {
    const [task] = yield* sql<{ id: number }>`SELECT i.id FROM inbox i
      JOIN session s ON s.id = i.recipient_session_id AND s.message_id = i.id
      WHERE i.recipient_session_id = ${sessionId} AND i.status = 'pending' AND i.recipient_execution_id IS NULL`

    if (task !== undefined)
      yield* publish(SessionEvent.InboxDelivering, { sessionId, messageId: task.id, execution }, { at })
  })

const recorded = (sql: SqlClient.SqlClient, sender: Sender) =>
  Effect.gen(function* () {
    const local = localSessionOf(sender)
    const found = local === undefined ? undefined : yield* senderOf(sql, local)

    return found === undefined ? sender : { ...found, type: "agent" as const }
  })

export const queuedFrom = (sql: SqlClient.SqlClient, sender: Sender, request: string) =>
  recorded(sql, sender).pipe(
    Effect.flatMap(
      (as) => sql<{ session: string; id: number }>`SELECT recipient_session_id AS session, id FROM inbox
        WHERE sender_key = ${senderKey(as)} AND request_id = ${request}`,
    ),
    Effect.map((rows) => rows[0]),
  )

const executionOf = (sql: SqlClient.SqlClient, sender: Sender) => {
  const local = localSessionOf(sender)

  return local === undefined ? Effect.succeed(undefined) : openExecution(sql, local)
}

export const queueSend = (
  sql: SqlClient.SqlClient,
  publish: Bus.Interface["publish"],
  recipient: string,
  sender: Sender,
  message: string,
  request?: string,
) =>
  Effect.gen(function* () {
    const id = yield* queueInbox(sql, publish, {
      senderExecution: yield* executionOf(sql, sender),
      recipient,
      sender: yield* recorded(sql, sender),
      content: envelopeFrom(sender, message),
      request,
    })

    return (yield* inboxIn(sql, recipient, [id]))[0]!
  })

const noticeTo = (sql: SqlClient.SqlClient, publish: Bus.Interface["publish"], recipient: string, content: string) =>
  Effect.gen(function* () {
    if (!(yield* isLiveSession(sql, recipient))) return false
    yield* queueInbox(sql, publish, {
      recipient,
      sender: { type: "vibest" },
      content: noticeEnvelope(content),
    })

    return true
  })

export const insertInboxRow = (
  sql: SqlClient.SqlClient,
  publish: Bus.Interface["publish"],
  row: NewInboxRow,
  at?: number,
) =>
  Effect.gen(function* () {
    const heir = yield* nearestAlive(sql, row.sessionId)

    if (heir === undefined) return undefined

    if ("remote" in heir) {
      yield* queueForRemote(sql, publish, heir.remote, heir.session, {
        sessionId: row.sessionId,
        content: row.message,
        kind: "notice",
        ...(at !== undefined && { at }),
      })

      return undefined
    }

    const id = yield* queueInbox(sql, publish, {
      recipient: heir.local,
      sender: { type: "vibest" },
      about: row.sessionId,
      content: noticeEnvelope(row.message),
      at,
    })

    return (yield* inboxIn(sql, heir.local, [id]))[0]
  })

export const tellSender = (
  sql: SqlClient.SqlClient,
  publish: Bus.Interface["publish"],
  sender: string,
  content: string,
) =>
  Effect.gen(function* () {
    if ((yield* sql`SELECT 1 FROM session WHERE id = ${sender}`).length === 0) return

    if (yield* noticeTo(sql, publish, sender, content)) return
    yield* insertInboxRow(sql, publish, { sessionId: sender, message: content })
  })

export const confirm = (sql: SqlClient.SqlClient, bus: Bus.Interface, sessionId: string, execution: number) =>
  moveInbox(
    sql,
    bus,
    sql`recipient_session_id = ${sessionId} AND status = 'delivering' AND recipient_execution_id = ${execution}
      AND (id = (SELECT message_id FROM session WHERE id = ${sessionId})
        OR EXISTS (SELECT 1 FROM execution e WHERE e.session_id = ${sessionId} AND e.id = ${execution}
          AND e.outcome = 'completed' AND e.typed IS NULL))`,
    "delivered",
    { execution },
  )

export const confirmBatch = (
  sql: SqlClient.SqlClient,
  bus: Bus.Interface,
  sessionId: string,
  execution: number,
  ids: ReadonlyArray<number>,
) =>
  ids.length === 0
    ? Effect.void
    : moveInbox(
        sql,
        bus,
        sql`recipient_session_id = ${sessionId} AND status = 'delivering' AND recipient_execution_id = ${execution}
          AND ${sql.in("id", ids)}`,
        "delivered",
        { execution },
      )

export const confirmTask = (sql: SqlClient.SqlClient, bus: Bus.Interface, sessionId: string, execution: number) =>
  moveInbox(
    sql,
    bus,
    sql`recipient_session_id = ${sessionId} AND status = 'delivering' AND recipient_execution_id = ${execution}
      AND id = (SELECT message_id FROM session WHERE id = ${sessionId})`,
    "delivered",
    { execution },
  )

export const dropUnsent = (sql: SqlClient.SqlClient, bus: Bus.Interface, sessionId: string, reason: string) =>
  moveInbox(
    sql,
    bus,
    sql`recipient_session_id = ${sessionId} AND status IN ('pending', 'delivering')
      AND id = (SELECT message_id FROM session WHERE id = ${sessionId})`,
    "dropped",
    { reason },
  )

export const waitingOn = (sql: SqlClient.SqlClient, id: string) =>
  sql<{ id: number }>`SELECT id FROM inbox
    WHERE (recipient_session_id = ${id} OR sender_session_id = ${id} OR about_session_id = ${id})
      AND status = 'pending'
    LIMIT 1`.pipe(Effect.map((rows) => rows.length > 0))
