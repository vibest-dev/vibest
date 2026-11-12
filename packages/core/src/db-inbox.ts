import { ExecutionAccepted, type InboxKind } from "@vibest/schema/event"
import { InboxRow, InboxStatus, type ExecutionState } from "@vibest/schema/session"
import { Effect } from "effect"

import { nextBatch } from "./batch.ts"
import { failureOf, type NewInboxRow, type ExecutionEnd } from "./db-rows.ts"
import type { Store } from "./db-store.ts"
import { type ObservedEnd } from "./replies.ts"

export const inboxMethods = (store: Store) => {
  const {
    sql,
    reads,
    now,
    tx,
    findSession,
    liveRecipient,
    queueSend,
    tellSender,
    queueForPeer,
    origins,
    currentProcess,
    inbox,
    inboxIn,
    findSend,
    openExecution,
    startExecution,
    moveInbox,
    linkTask,
    insertInboxRow,
    endExecution,
    updateSession,
    setStatus,
    emit,
    currentProcessId,
  } = store
  const queuedBy = reads.queuedBy
  const observable = (id: string) =>
    sql<{ ok: number }>`SELECT 1 AS ok FROM session s WHERE s.id = ${id} AND s.ended_at IS NULL`.pipe(
      Effect.map((rows) => rows.length > 0),
    )
  const acceptedAt = (id: string, execution: number) =>
    sql<{ at: number | null }>`SELECT accepted_at AS at FROM execution
      WHERE session_id = ${id} AND id = ${execution}`.pipe(Effect.map((rows) => rows[0]?.at ?? null))
  const accept = (id: string, execution: number) =>
    Effect.gen(function* () {
      if ((yield* openExecution(id)) !== execution) return false
      if ((yield* acceptedAt(id, execution)) === null)
        yield* emit(ExecutionAccepted, { sessionId: id, data: { execution } })
      return true
    })
  const isEntry = (id: string) =>
    sql`SELECT 1 FROM project WHERE entry_session_id = ${id}`.pipe(Effect.map((rows) => rows.length > 0))
  const fromOldProcess = (id: string, process: number | undefined) =>
    Effect.map(currentProcessId(id), (current) => process !== undefined && process !== current)
  return {
    insertInbox: (row: NewInboxRow) => tx(insertInboxRow(row)).pipe(Effect.orDie),

    insertSend: (recipient: string, message: string, request?: string, sender?: string) =>
      tx(
        Effect.gen(function* () {
          const before = request === undefined ? undefined : yield* queuedBy(recipient, request)
          if (before !== undefined) return (yield* inboxIn(recipient, [before]))[0]
          if (!(yield* liveRecipient(recipient))) return undefined
          return yield* queueSend(recipient, sender, message, request)
        }),
      ).pipe(Effect.orDie),

    insertNoticeTo: (recipient: string, message: string) => tx(tellSender(recipient, message)).pipe(Effect.orDie),

    sendToOrigin: (sessionId: string, target: string, message: string) =>
      tx(
        Effect.gen(function* () {
          const origin = yield* origins(sessionId)
          const creator = origin?.session
          if (!origin?.peer || !creator || target.length < 8 || !creator.startsWith(target)) return undefined
          const written = yield* queueForPeer(origin.peer, creator, {
            sessionId,
            kind: "send",
            content: message,
          })
          return written
        }),
      ).pipe(Effect.orDie),

    queuedBy: (sessionId: string, request: string) =>
      queuedBy(sessionId, request).pipe(
        Effect.map((id) => id !== undefined),
        Effect.orDie,
      ),

    inboxParties: (sessionId: string, inboxId: number) =>
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

    archiveIfNoPending: (id: string) =>
      tx(
        Effect.gen(function* () {
          const s = yield* findSession(id)
          if (s === undefined) return false
          const waiting = yield* sql<{ id: number }>`SELECT id FROM inbox
            WHERE ((session_id = ${id} OR sender_session_id = ${id}) AND status IN ('pending', 'delivering'))
              OR (session_id = ${id} AND kind = 'task' AND execution_id IS NULL)
            LIMIT 1`
          if (waiting.length > 0) return false
          const children =
            yield* sql`SELECT 1 FROM session WHERE parent_session_id = ${id} AND ended_at IS NULL LIMIT 1`
          if (children.length > 0) return false
          if ((yield* openExecution(id)) !== undefined) return false
          yield* updateSession(id, { metadata: { ...s.metadata, archived: true, removed: true } })
          return true
        }),
      ).pipe(Effect.orDie),

    openExecution: (id: string) => openExecution(id).pipe(Effect.orDie),

    archive: (id: string) =>
      tx(
        Effect.gen(function* () {
          if ((yield* openExecution(id)) !== undefined) yield* endExecution(id, { outcome: "interrupted" })
          yield* store.archive(id)
        }),
      ).pipe(Effect.orDie),

    startExecution: (id: string, at: number) =>
      tx(
        Effect.gen(function* () {
          const open = yield* openExecution(id)
          if (open !== undefined) return { execution: open, opened: false }
          return { execution: yield* startExecution(id, at), opened: true }
        }),
      ).pipe(Effect.orDie),

    acceptExecution: (id: string, execution: number) => tx(accept(id, execution)).pipe(Effect.orDie),

    executionAccepted: (id: string) =>
      Effect.gen(function* () {
        const execution = yield* openExecution(id)
        return execution !== undefined && (yield* acceptedAt(id, execution)) !== null
      }).pipe(Effect.orDie),

    currentProcessId: (id: string) => currentProcessId(id).pipe(Effect.orDie),

    closeExecution: (
      id: string,
      execution: number,
      status: Exclude<ExecutionState, "none" | "open">,
      options: { readonly failure?: string; readonly notice?: string } = {},
    ) =>
      tx(
        Effect.gen(function* () {
          if ((yield* openExecution(id)) !== execution) return false
          const failure = failureOf(options.failure)
          yield* endExecution(id, { outcome: status, ...(failure === undefined ? {} : { failure }) })
          if (options.notice !== undefined && !(yield* isEntry(id)))
            yield* insertInboxRow({ sessionId: id, message: options.notice })
          return true
        }),
      ).pipe(Effect.orDie),

    linkTask: (id: string) =>
      tx(
        Effect.gen(function* () {
          const execution = yield* openExecution(id)
          if (execution !== undefined) yield* linkTask(id, execution, yield* now)
        }),
      ).pipe(Effect.orDie),

    untakenTask: (id: string) => reads.untakenTask(id).pipe(Effect.orDie),

    hasQueued: (id: string) =>
      sql<{ id: number }>`SELECT id FROM inbox WHERE session_id = ${id}
          AND ((kind != 'task' AND status = 'pending') OR (kind = 'task' AND execution_id IS NULL))
        LIMIT 1`.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.orDie,
      ),

    executionTaken: (id: string) =>
      Effect.gen(function* () {
        const execution = yield* openExecution(id)
        if (execution === undefined) return false
        const [row] = yield* sql<{ taken: number }>`SELECT (t.accepted_at IS NOT NULL OR t.typed IS NOT NULL) AS taken
          FROM execution t WHERE t.session_id = ${id} AND t.id = ${execution}`
        return row?.taken === 1
      }).pipe(Effect.orDie),

    limitedSince: (sessionId: string, at: number) =>
      sql<{ harness: string; provider: string | null }>`SELECT harness, provider FROM process
        WHERE session_id = ${sessionId} AND end_reason = 'limited' AND ended_at >= ${at}
        ORDER BY id`.pipe(Effect.orDie),

    rescheduleSource: (id: string) => reads.rescheduleSource(id).pipe(Effect.orDie),

    limitSource: (id: string, limited: number) =>
      tx(
        Effect.gen(function* () {
          if ((yield* openExecution(id)) !== undefined) return undefined
          const [newest] = yield* sql<{
            id: number | null
          }>`SELECT max(id) AS id FROM execution WHERE session_id = ${id}`
          if ((newest?.id ?? 0) > limited) return undefined
          return yield* reads.rescheduleSource(id)
        }),
      ).pipe(Effect.orDie),

    startObserved: (id: string, typed: string | undefined, at: number, process?: number) =>
      tx(
        Effect.gen(function* () {
          if (!(yield* observable(id)) || (yield* fromOldProcess(id, process))) return
          const open = (yield* openExecution(id)) ?? (typed ? yield* startExecution(id, at, typed) : undefined)
          if (open === undefined) return
          yield* accept(id, open)
          yield* setStatus(id, "working")
        }),
      ).pipe(Effect.orDie),

    endObserved: (id: string, end: ObservedEnd, process?: number) =>
      tx(
        Effect.gen(function* () {
          if (!(yield* observable(id)) || (yield* fromOldProcess(id, process))) return undefined
          const current = yield* currentProcess(id)
          if (current === undefined || current.start.harness !== end.harness) return undefined
          if (end.needsReady && current.readyAt === null) return undefined
          const open = yield* openExecution(id)
          if (open === undefined && end.status === "interrupted") return undefined
          if (open !== undefined && (yield* acceptedAt(id, open)) === null) return "unaccepted" as const
          const failure = end.limited ? { message: end.failure ?? "", kind: "limit" as const } : failureOf(end.failure)
          yield* endExecution(
            id,
            {
              outcome: end.status,
              ...(failure === undefined ? {} : { failure }),
              ...(end.conversation === undefined || end.conversation === current.conversation
                ? {}
                : { conversation: end.conversation }),
              reply: end.reply,
            },
            end.at,
          )
          yield* setStatus(id, "idle")
          if (end.status === "failed" && !end.limited && !(yield* isEntry(id)))
            yield* insertInboxRow(
              { sessionId: id, message: `${id}'s execution ended with an error: ${end.failure}` },
              end.at,
            )
          return end.status
        }),
      ).pipe(Effect.orDie),

    endExecution: (id: string, end: ExecutionEnd, notice: string | undefined, at?: number) =>
      tx(
        Effect.gen(function* () {
          const stamp = at === undefined ? undefined : Math.max(at, yield* now)
          yield* endExecution(id, end, stamp)
          if (notice !== undefined) yield* insertInboxRow({ sessionId: id, message: notice }, stamp)
        }),
      ).pipe(Effect.orDie),

    pendingInbox: (sessionId: string) => findSend(sessionId, "pending").pipe(Effect.orDie),

    inboxWithStatus: (sessionId: string, status: InboxStatus) => findSend(sessionId, status).pipe(Effect.orDie),

    recoverDelivering: (notice: (sessionId: string, messages: ReadonlyArray<string>) => string) =>
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

    deliveringInbox: inbox(sql`m.status = 'delivering'`).pipe(
      Effect.map((rows) => rows.map((r) => ({ id: r.id, sessionId: r.recipient ?? r.sender ?? "", kind: r.kind }))),
      Effect.orDie,
    ),

    claim: (sessionId: string, ids: ReadonlyArray<number>) =>
      Effect.gen(function* () {
        if (ids.length === 0) return [] as ReadonlyArray<number>
        const claimed = yield* moveInbox(
          sql`session_id = ${sessionId} AND ${sql.in("id", ids)} AND status = 'pending'`,
          "delivering",
        )
        return claimed.map((k) => k.id)
      }).pipe(Effect.orDie),

    unacceptedBatch: (sessionId: string, execution: number) =>
      tx(
        Effect.gen(function* () {
          if ((yield* openExecution(sessionId)) !== execution || (yield* acceptedAt(sessionId, execution)) !== null)
            return undefined
          return yield* inbox(
            sql`m.session_id = ${sessionId} AND m.kind != 'task' AND m.status = 'delivered' AND m.execution_id = ${execution}`,
          )
        }),
      ).pipe(Effect.orDie),

    deliveredIn: (sessionId: string, execution: number) =>
      inbox(
        sql`m.session_id = ${sessionId} AND m.kind != 'task' AND m.status = 'delivered' AND m.execution_id = ${execution}`,
      ).pipe(Effect.orDie),

    takeInbox: (sessionId: string, process: number | undefined) =>
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

    setInboxStatus: (
      sessionId: string,
      ids: ReadonlyArray<number>,
      status: InboxStatus,
      from?: InboxStatus,
      into?: number,
    ) =>
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

    latestInbox: (sessionId: string, kind: InboxKind) =>
      (kind === "send"
        ? inbox(sql`m.session_id = ${sessionId} AND m.kind = 'send'`, sql`m.id DESC LIMIT 1`)
        : inbox(sql`m.kind = ${kind} AND m.sender_session_id = ${sessionId}`, sql`m.id DESC LIMIT 1`)
      ).pipe(
        Effect.map((rows) => rows[0]),
        Effect.orDie,
      ),

    latestReply: (sessionId: string) =>
      sql<{
        execution: number
        status: string
        text: string | null
        failure: string | null
        endedAt: number
      }>`SELECT id AS execution, outcome AS status, reply AS text, failure, ended_at FROM execution
        WHERE session_id = ${sessionId} AND outcome IS NOT NULL ORDER BY id DESC LIMIT 1`.pipe(
        Effect.map((rows) => rows[0]),
        Effect.orDie,
      ),

    endedAtLimit: sql<{
      id: string
      runtime: string
    }>`SELECT s.id, p.runtime FROM session s
      JOIN process p ON p.session_id = s.id AND p.id = s.process_id
      JOIN execution t ON t.session_id = s.id AND t.id = (SELECT max(id) FROM execution WHERE session_id = s.id)
      WHERE s.ended_at IS NULL AND p.ended_at IS NOT NULL AND t.failure_kind = 'limit'`.pipe(Effect.orDie),

    limitedExecution: (sessionId: string) =>
      sql<{
        execution: number
        process: number | null
        failure: string
      }>`SELECT id AS execution, process_id AS process, failure FROM execution
        WHERE session_id = ${sessionId} AND failure_kind = 'limit'
          AND id = (SELECT max(id) FROM execution WHERE session_id = ${sessionId})`.pipe(
        Effect.map((rows) => rows[0]),
        Effect.orDie,
      ),

    projectOfSession: (sessionId: string) =>
      sql<{ project: string }>`SELECT project_id AS project FROM session WHERE id = ${sessionId}`.pipe(
        Effect.map((rows) => rows[0]?.project),
        Effect.orDie,
      ),
  }
}
