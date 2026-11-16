import { InboxMoved, InboxQueued, type InboxKind } from "@vibest/schema/event"
import { InboxRow, InboxStatus } from "@vibest/schema/session"
import { Clock, Effect } from "effect"
import { SqlClient, type Statement } from "effect/sql"

import { nextBatch } from "../batch.ts"
import { Bus } from "../bus.ts"
import { noticeEnvelope, sessionEnvelope } from "../replies.ts"
import { archived, type NewInboxRow } from "./db-rows.ts"
import type * as Remote from "./remote.ts"
import type * as Session from "./session-statements.ts"

type InboxKey = { readonly session: string; readonly id: number }

export const statements = (session: Session.Statements, remote: Remote.Statements) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const { publish, transaction: tx } = yield* Bus.Service
    const now = Clock.currentTimeMillis
    const { reads, openExecution, currentProcess, placed, findSession, nearestAlive } = session

    const inbox = reads.inboxWhere
    const inboxIn = (recipient: string, ids: ReadonlyArray<number>) =>
      inbox(sql`m.session_id = ${recipient} AND ${sql.in("m.id", ids)}`)
    const keysIn = (keys: ReadonlyArray<InboxKey>) =>
      sql.or(keys.map((k) => sql`(session_id = ${k.session} AND id = ${k.id})`))
    const findSend = (sessionId: string, status: InboxStatus) =>
      inbox(sql`m.session_id = ${sessionId} AND m.kind != 'task' AND m.status = ${status}`)
    const entryIdOf = (projectIdValue: string) =>
      sql`(SELECT entry_session_id FROM project WHERE id = ${projectIdValue})`

    const moveInbox = (
      where: Statement.Fragment,
      to: "pending" | "delivering" | "delivered" | "failed" | "dropped",
      into?: number,
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
            const execution = to === "delivered" ? (into ?? (yield* openExecution(r.session))) : undefined
            yield* publish(InboxMoved, {
              sessionId: r.session,
              at,
              data: { inbox: r.id, to, ...(execution === undefined ? {} : { execution }) },
            })
          }
          return moved.map((r): InboxKey => ({ session: r.session, id: r.id }))
        }),
      )

    const queueInbox = (row: {
      readonly recipient: string
      readonly kind: "task" | "send" | "notice"
      readonly sender: string | null
      readonly content: string
      readonly status: "pending" | "delivered" | "dropped"
      readonly request?: string | undefined
      readonly peerItem?: string | undefined
      readonly at?: number | undefined
    }) =>
      publish(InboxQueued, {
        sessionId: row.recipient,
        ...(row.at === undefined ? {} : { at: row.at }),
        data: {
          kind: row.kind,
          recipient: row.recipient,
          ...(row.sender === null ? {} : { sender: row.sender }),
          content: row.content,
          status: row.status,
          ...(row.request === undefined ? {} : { request: row.request }),
          ...(row.peerItem === undefined ? {} : { peerItem: row.peerItem }),
        },
      })

    const linkTask = (sessionId: string, execution: number, at: number) =>
      Effect.gen(function* () {
        const [task] = yield* sql<{ id: number }>`SELECT id FROM inbox WHERE session_id = ${sessionId}
          AND kind = 'task' AND status = 'delivered' AND execution_id IS NULL`
        if (task !== undefined)
          yield* publish(InboxMoved, { sessionId, at, data: { inbox: task.id, to: "delivered", execution } })
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

    const renderedSend = (sender: string | undefined, message: string) =>
      Effect.gen(function* () {
        if (sender === undefined) return message
        const [from] = yield* sql<{ name: string }>`SELECT name FROM session WHERE id = ${sender}`
        return sessionEnvelope({ id: sender, title: from?.name }, message)
      })

    const queueSend = (recipient: string, sender: string | undefined, message: string, request?: string) =>
      Effect.gen(function* () {
        const id = yield* queueInbox({
          recipient,
          kind: "send",
          sender: sender ?? null,
          content: yield* renderedSend(sender, message),
          status: "pending",
          request,
        })
        return (yield* inboxIn(recipient, [id]))[0]!
      })

    const noticeTo = (recipient: string, content: string) =>
      Effect.gen(function* () {
        if (!(yield* liveRecipient(recipient))) return false
        yield* queueInbox({
          recipient,
          kind: "notice",
          sender: null,
          content: noticeEnvelope(content),
          status: "pending",
        })
        return true
      })

    const insertInboxRow = (row: NewInboxRow, at?: number) =>
      Effect.gen(function* () {
        const heir = yield* nearestAlive(row.sessionId)
        if (heir === undefined) return undefined
        const insert = (recipient: string, status: "pending" | "dropped") =>
          queueInbox({
            recipient,
            kind: "notice",
            sender: row.sessionId,
            content: noticeEnvelope(row.message),
            status,
            at,
          }).pipe(Effect.flatMap((id) => inboxIn(recipient, [id])))
        if ("peer" in heir) {
          const [queued] = yield* insert(row.sessionId, "dropped")
          yield* remote.queueForPeer(heir.peer, heir.session, {
            sessionId: row.sessionId,
            content: row.message,
            kind: "notice",
            ...(at === undefined ? {} : { at }),
          })
          return queued!
        }
        const [route] = yield* sql<{ project: string; entry: string | null }>`SELECT
            s.project_id AS project, p.entry_session_id AS entry
          FROM session s JOIN project p ON p.id = s.project_id WHERE s.id = ${heir.local}`
        const present = route?.entry !== heir.local || placed(route.project, yield* currentProcess(heir.local))
        const [queued] = yield* insert(heir.local, present ? "pending" : "dropped")
        return queued!
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
          WHERE (${keysIn(keys)}) AND kind = 'send' AND sender_session_id IS NOT NULL ORDER BY session_id, id`
        const groups = Map.groupBy(sends, (s) => `${s.sender}\n${s.recipient}`)
        for (const group of groups.values()) {
          const { sender, recipient } = group[0]!
          yield* tellSender(
            sender,
            `A message to ${recipient} was not delivered: ${reason}\n\n${group.map((s) => s.content).join("\n\n")}`,
          )
        }
      })

    const dropWaiting = (projectIdValue: string) =>
      Effect.gen(function* () {
        const dropped = yield* moveInbox(
          sql`status = 'pending' AND session_id = ${entryIdOf(projectIdValue)}`,
          "dropped",
        )
        yield* tellSendersOf(dropped, "the entry session is not running")
      })

    const waitingOn = (id: string) =>
      sql<{ id: number }>`SELECT id FROM inbox
        WHERE ((session_id = ${id} OR sender_session_id = ${id}) AND status IN ('pending', 'delivering'))
          OR (session_id = ${id} AND kind = 'task' AND execution_id IS NULL)
        LIMIT 1`.pipe(Effect.map((rows) => rows.length > 0))

    return {
      inbox,
      inboxIn,
      findSend,
      moveInbox,
      queueInbox,
      linkTask,
      queueSend,
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
      liveRecipient,
      tellSender,
      insertInboxRow,
    } = inbox

    return {
      insertInbox: Effect.fn("Db.inbox.insertInbox")((row: NewInboxRow) => tx(insertInboxRow(row)).pipe(Effect.orDie)),

      insertSend: Effect.fn("Db.inbox.insertSend")(
        (recipient: string, message: string, request?: string, sender?: string) =>
          tx(
            Effect.gen(function* () {
              const before = request === undefined ? undefined : yield* reads.queuedBy(recipient, request)
              if (before !== undefined) return (yield* inboxIn(recipient, [before]))[0]
              if (!(yield* liveRecipient(recipient))) return undefined
              return yield* queueSend(recipient, sender, message, request)
            }),
          ).pipe(Effect.orDie),
      ),

      insertNoticeTo: Effect.fn("Db.inbox.insertNoticeTo")((recipient: string, message: string) =>
        tx(tellSender(recipient, message)).pipe(Effect.orDie),
      ),

      queuedBy: Effect.fn("Db.inbox.queuedBy")((sessionId: string, request: string) =>
        reads.queuedBy(sessionId, request).pipe(
          Effect.map((id) => id !== undefined),
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

      inboxParties: Effect.fn("Db.inbox.inboxParties")((sessionId: string, inboxId: number) =>
        sql<{
          recipient: string
          sender: string | null
        }>`SELECT session_id AS recipient, sender_session_id AS sender FROM inbox
          WHERE session_id = ${sessionId} AND id = ${inboxId}`.pipe(
          Effect.map((rows) =>
            [rows[0]?.recipient, rows[0]?.sender].filter((id): id is string => typeof id === "string"),
          ),
          Effect.orDie,
        ),
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

      hasQueued: Effect.fn("Db.inbox.hasQueued")((id: string) =>
        sql<{ id: number }>`SELECT id FROM inbox WHERE session_id = ${id}
            AND ((kind != 'task' AND status = 'pending') OR (kind = 'task' AND execution_id IS NULL))
          LIMIT 1`.pipe(
          Effect.map((rows) => rows.length > 0),
          Effect.orDie,
        ),
      ),

      pendingInbox: Effect.fn("Db.inbox.pendingInbox")((sessionId: string) =>
        findSend(sessionId, "pending").pipe(Effect.orDie),
      ),

      inboxWithStatus: Effect.fn("Db.inbox.inboxWithStatus")((sessionId: string, status: InboxStatus) =>
        findSend(sessionId, status).pipe(Effect.orDie),
      ),

      recoverDelivering: Effect.fn("Db.inbox.recoverDelivering")(
        (notice: (sessionId: string, messages: ReadonlyArray<string>) => string) =>
          tx(
            Effect.gen(function* () {
              const cut = yield* sql<{
                id: number
                recipient: string
                sender: string | null
                content: string
              }>`SELECT id, session_id AS recipient,
                CASE WHEN kind = 'send' THEN sender_session_id END AS sender, content FROM inbox
              WHERE status = 'delivering' ORDER BY session_id, id`
              const bySenderAndSession = new Map<string, Array<(typeof cut)[number]>>()
              for (const row of cut) {
                const key = `${row.sender ?? ""}\n${row.recipient}`
                bySenderAndSession.set(key, [...(bySenderAndSession.get(key) ?? []), row])
              }
              for (const rows of bySenderAndSession.values()) {
                const { sender, recipient } = rows[0]!
                yield* moveInbox(
                  sql`session_id = ${recipient} AND ${sql.in(
                    "id",
                    rows.map((r) => r.id),
                  )}`,
                  "failed",
                )
                const message = notice(
                  recipient,
                  rows.map((r) => r.content),
                )
                if (sender !== null) yield* tellSender(sender, message)
                else yield* insertInboxRow({ sessionId: recipient, message })
              }
            }),
          ).pipe(Effect.orDie),
      ),

      deliveringInbox: inboxWhere(sql`m.status = 'delivering'`).pipe(
        Effect.map((rows) => rows.map((r) => ({ id: r.id, sessionId: r.recipient ?? r.sender ?? "", kind: r.kind }))),
        Effect.orDie,
      ),

      claim: Effect.fn("Db.inbox.claim")((sessionId: string, ids: ReadonlyArray<number>) =>
        Effect.gen(function* () {
          if (ids.length === 0) return [] as ReadonlyArray<number>
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
              sql`m.session_id = ${sessionId} AND m.kind != 'task' AND m.status = 'delivered' AND m.execution_id = ${execution}`,
            )
          }),
        ).pipe(Effect.orDie),
      ),

      deliveredIn: Effect.fn("Db.inbox.deliveredIn")((sessionId: string, execution: number) =>
        inboxWhere(
          sql`m.session_id = ${sessionId} AND m.kind != 'task' AND m.status = 'delivered' AND m.execution_id = ${execution}`,
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
              execution,
            )
            return { execution, rows: batch }
          }),
        ).pipe(Effect.orDie),
      ),

      setInboxStatus: Effect.fn("Db.inbox.setInboxStatus")(
        (sessionId: string, ids: ReadonlyArray<number>, status: InboxStatus, from?: InboxStatus, into?: number) =>
          Effect.gen(function* () {
            if (ids.length === 0) return [] as ReadonlyArray<InboxRow>
            const moved = yield* moveInbox(
              sql`session_id = ${sessionId} AND ${sql.in("id", ids)}${from ? sql` AND status = ${from}` : sql``}`,
              status,
              into,
            )
            return moved.length === 0
              ? []
              : yield* inboxIn(
                  sessionId,
                  moved.map((k) => k.id),
                )
          }).pipe(Effect.orDie),
      ),

      latestInbox: Effect.fn("Db.inbox.latestInbox")((sessionId: string, kind: InboxKind) =>
        (kind === "send"
          ? inboxWhere(sql`m.session_id = ${sessionId} AND m.kind = 'send'`, sql`m.id DESC LIMIT 1`)
          : inboxWhere(sql`m.kind = ${kind} AND m.sender_session_id = ${sessionId}`, sql`m.id DESC LIMIT 1`)
        ).pipe(
          Effect.map((rows) => rows[0]),
          Effect.orDie,
        ),
      ),
    }
  })

export type Interface = Effect.Success<ReturnType<typeof make>>
