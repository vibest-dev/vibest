import {
  InboxDelivered,
  InboxDeliveryFailed,
  InboxDeliveryStarted,
  InboxDropped,
  InboxEnqueued,
  type Sender,
} from "@vibest/schema/event"
import { InboxStatus } from "@vibest/schema/session"
import { Clock, Effect } from "effect"
import { SqlClient, type Statement } from "effect/sql"

import { nextBatch } from "../batch.ts"
import { Bus } from "../bus.ts"
import { envelopeFrom, noticeEnvelope } from "../replies.ts"
import { archived, localSessionOf, type NewInboxRow, senderKey } from "./db-rows.ts"
import type * as Remote from "./remote.ts"
import type * as Session from "./session-statements.ts"

type InboxKey = { readonly session: string; readonly id: number }

export const statements = (session: Session.Statements, remote: Remote.Statements) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const { publish, transaction: tx } = yield* Bus.Service
    const now = Clock.currentTimeMillis
    const { reads, openExecution, currentProcess, placed, findSession, nearestAlive, labelOf } = session

    const inbox = reads.inboxWhere

    const inboxIn = (recipient: string, ids: ReadonlyArray<number>) =>
      inbox(sql`m.session_id = ${recipient} AND ${sql.in("m.id", ids)}`)

    const keysIn = (keys: ReadonlyArray<InboxKey>) =>
      sql.or(keys.map((k) => sql`(session_id = ${k.session} AND id = ${k.id})`))

    const notDelegation = sql`NOT EXISTS (SELECT 1 FROM session s WHERE s.id = m.session_id AND s.message_id = m.id)`

    const findSend = (sessionId: string, status: InboxStatus) =>
      inbox(sql`m.session_id = ${sessionId} AND m.status = ${status} AND ${notDelegation}`)

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
          }>`SELECT id, status, session_id AS session FROM inbox WHERE ${where} ORDER BY session_id, id`

          const moved = rows.filter((r) => r.status !== to)
          const at = yield* now

          for (const r of moved) {
            if (to === "delivering") {
              yield* publish(InboxDeliveryStarted, { sessionId: r.session, at, data: { messageId: r.id } })
              continue
            }

            if (to === "delivered") {
              const execution = detail?.execution ?? (yield* openExecution(r.session))

              if (execution === undefined)
                return yield* Effect.die(new Error(`inbox ${r.session} ${r.id} delivered without an execution`))
              yield* publish(InboxDelivered, {
                sessionId: r.session,
                at,
                data: { messageId: r.id, recipientExecutionId: execution },
              })
              continue
            }

            const reason = detail?.reason

            if (reason === undefined)
              return yield* Effect.die(new Error(`inbox ${r.session} ${r.id} ${to} without a reason`))
            yield* publish(to === "failed" ? InboxDeliveryFailed : InboxDropped, {
              sessionId: r.session,
              at,
              data: { messageId: r.id, reason },
            })
          }

          return moved.map((r): InboxKey => ({ session: r.session, id: r.id }))
        }),
      )

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
      publish(InboxEnqueued, {
        sessionId: row.recipient,
        ...(row.at !== undefined && { at: row.at }),
        data: {
          sender: row.sender,
          content: row.content,
          ...(row.about !== undefined && { aboutSessionId: row.about }),
          ...(row.request !== undefined && { requestId: row.request }),
          ...(row.transfer !== undefined && { transferId: row.transfer }),
          ...(row.senderExecution !== undefined && { senderExecutionId: row.senderExecution }),
        },
      })

    const linkTask = (sessionId: string, execution: number, at: number) =>
      Effect.gen(function* () {
        const [task] = yield* sql<{ id: number }>`SELECT i.id FROM inbox i
          JOIN session s ON s.id = i.session_id AND s.message_id = i.id
          WHERE i.session_id = ${sessionId} AND i.status = 'pending' AND i.recipient_execution_id IS NULL`

        if (task !== undefined)
          yield* publish(InboxDelivered, {
            sessionId,
            at,
            data: { messageId: task.id, recipientExecutionId: execution },
          })
      })

    const liveRecipient = (id: string) =>
      Effect.gen(function* () {
        const [route] = yield* sql<{
          project: string
          entry: string | null
        }>`SELECT s.project_id AS project, p.entry_session_id AS entry
          FROM session s JOIN project p ON p.id = s.project_id WHERE s.id = ${id}`

        if (route === undefined) return false

        if (route.entry === id) return placed(route.project, yield* currentProcess(id))
        const found = yield* findSession(id)

        return found !== undefined && !archived(found)
      })

    const recorded = (sender: Sender) =>
      Effect.gen(function* () {
        const local = localSessionOf(sender)

        const found = local === undefined ? undefined : yield* remote.senderOf(local)

        return found === undefined ? sender : { ...found, type: "agent" as const }
      })

    const queuedFrom = (sender: Sender, request: string) =>
      recorded(sender).pipe(
        Effect.flatMap(
          (as) => sql<{ session: string; id: number }>`SELECT session_id AS session, id FROM inbox
            WHERE sender_key = ${senderKey(as)} AND request = ${request}`,
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

        if ("peer" in heir) {
          yield* remote.queueForPeer(heir.peer, heir.session, {
            sessionId: row.sessionId,
            content: row.message,
            kind: "notice",
            ...(at !== undefined && { at }),
          })

          return undefined
        }

        const [route] = yield* sql<{ project: string; entry: string | null }>`SELECT
            s.project_id AS project, p.entry_session_id AS entry
          FROM session s JOIN project p ON p.id = s.project_id WHERE s.id = ${heir.local}`

        const present = route?.entry !== heir.local || placed(route.project, yield* currentProcess(heir.local))

        const id = yield* queueInbox({
          recipient: heir.local,
          sender: { type: "vibest" },
          about: row.sessionId,
          content: noticeEnvelope(row.message),
          at,
        })

        if (!present)
          yield* moveInbox(sql`session_id = ${heir.local} AND id = ${id}`, "dropped", {
            reason: "the entry session is not running",
          })

        return (yield* inboxIn(heir.local, [id]))[0]
      })

    const tellSender = (sender: string, content: string) =>
      Effect.gen(function* () {
        if ((yield* sql`SELECT 1 FROM session WHERE id = ${sender}`).length === 0) return

        if (yield* noticeTo(sender, content)) return
        yield* insertInboxRow({ sessionId: sender, message: content })
      })

    const tellSendersOf = (keys: ReadonlyArray<InboxKey>, reason: string) =>
      Effect.gen(function* () {
        if (keys.length === 0) return

        const sends = yield* sql<{
          sender: string
          recipient: string
          content: string
        }>`SELECT sender_session_id AS sender, session_id AS recipient, content FROM inbox
          WHERE (${keysIn(keys)}) AND sender_type = 'agent' AND sender_session_id IS NOT NULL AND sender_machine IS NULL
            AND NOT EXISTS (SELECT 1 FROM session s WHERE s.id = inbox.session_id AND s.message_id = inbox.id)
          ORDER BY session_id, id`

        const groups = Map.groupBy(sends, (s) => `${s.sender}\n${s.recipient}`)

        for (const group of groups.values()) {
          const { sender, recipient } = group[0]!
          yield* tellSender(
            sender,
            `A message to ${yield* labelOf(recipient)} was not delivered: ${reason}\n\n${group.map((s) => s.content).join("\n\n")}`,
          )
        }
      })

    const dropWaiting = (entry: string) =>
      Effect.gen(function* () {
        const dropped = yield* moveInbox(sql`status = 'pending' AND session_id = ${entry}`, "dropped", {
          reason: "the entry session is not running",
        })

        yield* tellSendersOf(dropped, "the entry session is not running")
      })

    const waitingOn = (id: string) =>
      sql<{ id: number }>`SELECT id FROM inbox
        WHERE (session_id = ${id} OR sender_session_id = ${id} OR about_session_id = ${id})
          AND status IN ('pending', 'delivering')
        LIMIT 1`.pipe(Effect.map((rows) => rows.length > 0))

    return {
      inbox,
      inboxIn,
      findSend,
      moveInbox,
      queueInbox,
      linkTask,
      queueSend,
      queuedFrom,
      liveRecipient,
      tellSender,
      insertInboxRow,
      dropWaiting,
      waitingOn,
    }
  })

export type Statements = Effect.Success<ReturnType<typeof statements>>

export const make = (session: Session.Statements, inbox: Statements) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const { transaction: tx } = yield* Bus.Service
    const now = Clock.currentTimeMillis
    const { reads, openExecution, acceptedAt, observable, fromOldProcess, startExecution, creatorOf } = session

    const {
      inbox: inboxWhere,
      inboxIn,
      findSend,
      moveInbox,
      queueSend,
      queuedFrom,
      liveRecipient,
      tellSender,
      insertInboxRow,
      waitingOn,
    } = inbox

    return {
      insertInbox: Effect.fn("Db.inbox.insertInbox")((row: NewInboxRow) => tx(insertInboxRow(row)).pipe(Effect.orDie)),

      insertSend: Effect.fn("Db.inbox.insertSend")(
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

      insertNoticeTo: Effect.fn("Db.inbox.insertNoticeTo")((recipient: string, message: string) =>
        tx(tellSender(recipient, message)).pipe(Effect.orDie),
      ),

      sentIn: Effect.fn("Db.inbox.sentIn")((sessionId: string, execution: number) =>
        sql<{ sent: number }>`SELECT sent FROM execution WHERE session_id = ${sessionId} AND id = ${execution}`.pipe(
          Effect.map((rows) => rows[0]?.sent ?? 0),
          Effect.orDie,
        ),
      ),

      queuedFrom: Effect.fn("Db.inbox.queuedFrom")((sender: Sender, request: string) =>
        queuedFrom(sender, request).pipe(
          Effect.map((row) => row !== undefined),
          Effect.orDie,
        ),
      ),

      maySend: Effect.fn("Db.inbox.maySend")((sender: string, recipient: string) =>
        Effect.gen(function* () {
          const local = (creator: Session.Creator) =>
            creator !== undefined && "local" in creator ? creator.local : undefined

          return local(yield* creatorOf(sender)) === recipient || local(yield* creatorOf(recipient)) === sender
        }),
      ),

      linkTask: Effect.fn("Db.inbox.linkTask")((id: string) =>
        tx(
          Effect.gen(function* () {
            const execution = yield* openExecution(id)

            if (execution !== undefined) yield* inbox.linkTask(id, execution, yield* now)
          }),
        ).pipe(Effect.orDie),
      ),

      untakenTask: Effect.fn("Db.inbox.untakenTask")((id: string) => reads.untakenTask(id).pipe(Effect.orDie)),

      waitingOn: Effect.fn("Db.inbox.waitingOn")((id: string) => waitingOn(id).pipe(Effect.orDie)),

      hasQueued: Effect.fn("Db.inbox.hasQueued")((id: string) =>
        sql<{ id: number }>`SELECT id FROM inbox WHERE session_id = ${id} AND status = 'pending' LIMIT 1`.pipe(
          Effect.map((rows) => rows.length > 0),
          Effect.orDie,
        ),
      ),

      pendingRecipients: Effect.fn("Db.inbox.pendingRecipients")(() =>
        sql<{ id: string }>`SELECT DISTINCT session_id AS id FROM inbox WHERE status = 'pending'`.pipe(
          Effect.map((rows) => rows.map((row) => row.id)),
          Effect.orDie,
        ),
      ),

      pendingInbox: Effect.fn("Db.inbox.pendingInbox")((sessionId: string) =>
        findSend(sessionId, "pending").pipe(Effect.orDie),
      ),

      inboxWithStatus: Effect.fn("Db.inbox.inboxWithStatus")((sessionId: string, status: InboxStatus) =>
        findSend(sessionId, status).pipe(Effect.orDie),
      ),

      deliveringInbox: inboxWhere(sql`m.status = 'delivering'`).pipe(
        Effect.map((rows) => rows.map((r) => ({ id: r.id, sessionId: r.recipient ?? "" }))),
        Effect.orDie,
      ),

      claim: Effect.fn("Db.inbox.claim")((sessionId: string, ids: ReadonlyArray<number>) =>
        Effect.gen(function* () {
          if (ids.length === 0) return []

          const claimed = yield* moveInbox(
            sql`session_id = ${sessionId} AND ${sql.in("id", ids)} AND status = 'pending'`,
            "delivering",
          )

          return claimed.map((k) => k.id)
        }).pipe(Effect.orDie),
      ),

      unacceptedBatch: Effect.fn("Db.inbox.unacceptedBatch")((sessionId: string, execution: number) =>
        tx(
          Effect.gen(function* () {
            if ((yield* openExecution(sessionId)) !== execution || (yield* acceptedAt(sessionId, execution)) !== null)
              return undefined

            return yield* inboxWhere(
              sql`m.session_id = ${sessionId} AND m.status = 'delivered' AND m.recipient_execution_id = ${execution}
                AND NOT EXISTS (SELECT 1 FROM session s WHERE s.id = m.session_id AND s.message_id = m.id)`,
            )
          }),
        ).pipe(Effect.orDie),
      ),

      deliveredIn: Effect.fn("Db.inbox.deliveredIn")((sessionId: string, execution: number) =>
        inboxWhere(
          sql`m.session_id = ${sessionId} AND m.status = 'delivered' AND m.recipient_execution_id = ${execution}
            AND NOT EXISTS (SELECT 1 FROM session s WHERE s.id = m.session_id AND s.message_id = m.id)`,
        ).pipe(Effect.orDie),
      ),

      takeInbox: Effect.fn("Db.inbox.takeInbox")((sessionId: string, process: number | undefined) =>
        tx(
          Effect.gen(function* () {
            if (!(yield* observable(sessionId)) || (yield* fromOldProcess(sessionId, process))) return undefined

            if ((yield* openExecution(sessionId)) !== undefined) return undefined
            const pending = yield* findSend(sessionId, "pending")

            if (pending.length === 0) return undefined
            const batch = nextBatch(pending)
            const execution = yield* startExecution(sessionId, yield* now)
            yield* moveInbox(
              sql`session_id = ${sessionId} AND ${sql.in(
                "id",
                batch.map((r) => r.id),
              )}`,
              "delivered",
              { execution },
            )

            return { execution, rows: batch }
          }),
        ).pipe(Effect.orDie),
      ),

      setInboxStatus: Effect.fn("Db.inbox.setInboxStatus")(
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
              sql`session_id = ${sessionId} AND ${sql.in("id", ids)}${from ? sql` AND status = ${from}` : sql``}`,
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

      latestInbox: Effect.fn("Db.inbox.latestInbox")((sessionId: string, which: "send" | "notice") =>
        (which === "send"
          ? inboxWhere(
              sql`m.session_id = ${sessionId} AND m.sender_type != 'vibest' AND NOT EXISTS (SELECT 1 FROM session s WHERE s.id = m.session_id AND s.message_id = m.id)`,
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

export type Interface = Effect.Success<ReturnType<typeof make>>
