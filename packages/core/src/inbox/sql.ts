import { type Sender } from "@vibest/schema/event"
import { InboxRow, type InboxStatus } from "@vibest/schema/session"
import { SessionEvent } from "@vibest/schema/session-event"
import { Clock, Effect, Schema } from "effect"
import { SqlClient, type Statement } from "effect/sql"

import { Bus } from "../bus.ts"
import {
  archived,
  type InboxSql as InboxColumns,
  localSessionOf,
  type NewInboxRow,
  senderKey,
  toInbox,
} from "../database/rows.ts"
import type { RemoteSql } from "../remote/sql.ts"
import { envelopeFrom, noticeEnvelope } from "../session/replies.ts"
import type { SessionSql } from "../session/sql.ts"

type InboxKey = { readonly session: string; readonly id: number }

const decodeInbox = Schema.decodeUnknownEffect(Schema.Array(InboxRow))

export const inboxSql = (session: SessionSql, remote: RemoteSql) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const { publish, transaction: tx } = yield* Bus.Service
    const now = Clock.currentTimeMillis
    const { openExecution, findSession, nearestAlive } = session

    const inbox = (where: Statement.Fragment, order: Statement.Fragment = sql`m.id`) =>
      sql<InboxColumns>`SELECT m.id, m.recipient_session_id AS session_id, m.sender_type, m.sender_session_id, m.sender_agent, m.sender_title,
          m.sender_machine, m.sender_plugin, m.content, m.status
        FROM inbox m WHERE ${where} ORDER BY ${order}`.pipe(Effect.flatMap((rows) => decodeInbox(rows.map(toInbox))))

    const inboxIn = (recipient: string, ids: ReadonlyArray<number>) =>
      inbox(sql`m.recipient_session_id = ${recipient} AND ${sql.in("m.id", ids)}`)

    const notDelegation = sql`NOT EXISTS (SELECT 1 FROM session s WHERE s.id = m.recipient_session_id AND s.message_id = m.id)`

    const findSend = (sessionId: string, status: InboxStatus) =>
      inbox(sql`m.recipient_session_id = ${sessionId} AND m.status = ${status} AND ${notDelegation}`)

    const untakenTask = (id: string) =>
      sql<{ id: number; content: string }>`SELECT i.id, i.content FROM inbox i
        JOIN session s ON s.id = i.recipient_session_id AND s.message_id = i.id
        WHERE i.recipient_session_id = ${id} AND i.status = 'pending' AND i.recipient_execution_id IS NULL
        LIMIT 1`.pipe(Effect.map((rows) => rows[0]))

    const moveInbox = (
      where: Statement.Fragment,
      to: "delivering" | "delivered" | "failed" | "dropped",
      detail?: { readonly execution?: number; readonly reason?: string },
    ) =>
      tx(
        Effect.gen(function* () {
          const rows = yield* sql<{
            id: number
            status: string
            session: string
          }>`SELECT id, status, recipient_session_id AS session FROM inbox WHERE ${where} ORDER BY recipient_session_id, id`

          const moved = rows.filter((r) => r.status !== to)
          const at = yield* now

          for (const r of moved) {
            if (to === "delivering") {
              yield* publish(
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
              const execution = detail?.execution ?? (yield* openExecution(r.session))

              if (execution === undefined)
                return yield* Effect.die(new Error(`inbox ${r.session} ${r.id} delivered without an execution`))
              yield* publish(
                SessionEvent.InboxDelivered,
                { sessionId: r.session, messageId: r.id, recipientExecutionId: execution },
                { at },
              )
              continue
            }

            const reason = detail?.reason

            if (reason === undefined)
              return yield* Effect.die(new Error(`inbox ${r.session} ${r.id} ${to} without a reason`))
            yield* publish(
              to === "failed" ? SessionEvent.InboxFailed : SessionEvent.InboxDropped,
              { sessionId: r.session, messageId: r.id, reason },
              { at },
            )
          }

          return moved.map((r): InboxKey => ({ session: r.session, id: r.id }))
        }),
      )

    const nextMessageId = (sessionId: string) =>
      sql<{ id: number }>`SELECT coalesce(max(id), 0) + 1 AS id FROM inbox
        WHERE recipient_session_id = ${sessionId}`.pipe(Effect.map((rows) => rows[0]?.id ?? 1))

    const queueInbox = (row: {
      readonly recipient: string
      readonly sender: Sender
      readonly about?: string | undefined
      readonly content: string
      readonly request?: string | undefined
      readonly transfer?: string | undefined
      readonly senderExecution?: number | undefined
      readonly at?: number | undefined
    }) =>
      Effect.gen(function* () {
        const messageId = yield* nextMessageId(row.recipient)
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

    const linkTask = (sessionId: string, execution: number, at: number) =>
      Effect.gen(function* () {
        const [task] = yield* sql<{ id: number }>`SELECT i.id FROM inbox i
          JOIN session s ON s.id = i.recipient_session_id AND s.message_id = i.id
          WHERE i.recipient_session_id = ${sessionId} AND i.status = 'pending' AND i.recipient_execution_id IS NULL`

        if (task !== undefined)
          yield* publish(SessionEvent.InboxDelivering, { sessionId, messageId: task.id, execution }, { at })
      })

    const liveRecipient = (id: string) =>
      findSession(id).pipe(Effect.map((found) => found !== undefined && !archived(found)))

    const recorded = (sender: Sender) =>
      Effect.gen(function* () {
        const local = localSessionOf(sender)

        const found = local === undefined ? undefined : yield* remote.senderOf(local)

        return found === undefined ? sender : { ...found, type: "agent" as const }
      })

    const queuedFrom = (sender: Sender, request: string) =>
      recorded(sender).pipe(
        Effect.flatMap(
          (as) => sql<{ session: string; id: number }>`SELECT recipient_session_id AS session, id FROM inbox
            WHERE sender_key = ${senderKey(as)} AND request_id = ${request}`,
        ),
        Effect.map((rows) => rows[0]),
      )

    const executionOf = (sender: Sender) => {
      const local = localSessionOf(sender)

      return local === undefined ? Effect.succeed(undefined) : openExecution(local)
    }

    const queueSend = (recipient: string, sender: Sender, message: string, request?: string) =>
      Effect.gen(function* () {
        const id = yield* queueInbox({
          senderExecution: yield* executionOf(sender),
          recipient,
          sender: yield* recorded(sender),
          content: envelopeFrom(sender, message),
          request,
        })

        return (yield* inboxIn(recipient, [id]))[0]!
      })

    const noticeTo = (recipient: string, content: string) =>
      Effect.gen(function* () {
        if (!(yield* liveRecipient(recipient))) return false
        yield* queueInbox({
          recipient,
          sender: { type: "vibest" },
          content: noticeEnvelope(content),
        })

        return true
      })

    const insertInboxRow = (row: NewInboxRow, at?: number) =>
      Effect.gen(function* () {
        const heir = yield* nearestAlive(row.sessionId)

        if (heir === undefined) return undefined

        if ("remote" in heir) {
          yield* remote.queueForRemote(heir.remote, heir.session, {
            sessionId: row.sessionId,
            content: row.message,
            kind: "notice",
            ...(at !== undefined && { at }),
          })

          return undefined
        }

        const id = yield* queueInbox({
          recipient: heir.local,
          sender: { type: "vibest" },
          about: row.sessionId,
          content: noticeEnvelope(row.message),
          at,
        })

        return (yield* inboxIn(heir.local, [id]))[0]
      })

    const tellSender = (sender: string, content: string) =>
      Effect.gen(function* () {
        if ((yield* sql`SELECT 1 FROM session WHERE id = ${sender}`).length === 0) return

        if (yield* noticeTo(sender, content)) return
        yield* insertInboxRow({ sessionId: sender, message: content })
      })

    const confirm = (sessionId: string, execution: number) =>
      moveInbox(
        sql`recipient_session_id = ${sessionId} AND status = 'delivering' AND recipient_execution_id = ${execution}
          AND (id = (SELECT message_id FROM session WHERE id = ${sessionId})
            OR EXISTS (SELECT 1 FROM execution e WHERE e.session_id = ${sessionId} AND e.id = ${execution}
              AND e.outcome = 'completed' AND e.typed IS NULL))`,
        "delivered",
        { execution },
      )

    const confirmBatch = (sessionId: string, execution: number, ids: ReadonlyArray<number>) =>
      ids.length === 0
        ? Effect.void
        : moveInbox(
            sql`recipient_session_id = ${sessionId} AND status = 'delivering' AND recipient_execution_id = ${execution}
              AND ${sql.in("id", ids)}`,
            "delivered",
            { execution },
          )

    const confirmTask = (sessionId: string, execution: number) =>
      moveInbox(
        sql`recipient_session_id = ${sessionId} AND status = 'delivering' AND recipient_execution_id = ${execution}
          AND id = (SELECT message_id FROM session WHERE id = ${sessionId})`,
        "delivered",
        { execution },
      )

    const dropUnsent = (sessionId: string, reason: string) =>
      moveInbox(
        sql`recipient_session_id = ${sessionId} AND status IN ('pending', 'delivering')
          AND id = (SELECT message_id FROM session WHERE id = ${sessionId})`,
        "dropped",
        { reason },
      )

    const waitingOn = (id: string) =>
      sql<{ id: number }>`SELECT id FROM inbox
        WHERE (recipient_session_id = ${id} OR sender_session_id = ${id} OR about_session_id = ${id})
          AND status = 'pending'
        LIMIT 1`.pipe(Effect.map((rows) => rows.length > 0))

    return {
      inbox,
      inboxIn,
      findSend,
      untakenTask,
      moveInbox,
      queueInbox,
      confirm,
      confirmBatch,
      confirmTask,
      dropUnsent,
      linkTask,
      queueSend,
      queuedFrom,
      liveRecipient,
      tellSender,
      insertInboxRow,
      waitingOn,
    }
  })

export type InboxSql = Effect.Success<ReturnType<typeof inboxSql>>
