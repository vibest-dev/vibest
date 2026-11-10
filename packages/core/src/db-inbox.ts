import { TurnReported } from "@vibest/schema/event"
import { InboxKind, InboxRow, InboxStatus, TurnState } from "@vibest/schema/session"
import { Effect } from "effect"

import { encodeAddress, storedStatus, type SessionPatch, type NewInboxRow, type TurnEnd } from "./db-rows.ts"
import type { Store } from "./db-store.ts"
import { envelope, type TurnEnded } from "./results.ts"

export const inboxMethods = (store: Store) => {
  const {
    sql,
    reads,
    now,
    emit,
    tx,
    findSession,
    liveRecipient,
    queueSend,
    queueInbox,
    tellSender,
    tellSendersOf,
    queueForPeer,
    origins,
    currentProcessId,
    findCoordinators,
    inbox,
    inboxIn,
    findSend,
    entryOf,
    openTurn,
    startTurn,
    moveInbox,
    linkTask,
    insertInboxRow,
    updateSession,
    dropWaiting,
  } = store
  const queuedBy = reads.queuedBy
  return {
    insertInbox: (row: NewInboxRow) => tx(insertInboxRow(row)).pipe(Effect.orDie),

    insertSend: (recipient: string, message: string, request?: string, sender?: string) =>
      tx(
        Effect.gen(function* () {
          const before = request === undefined ? undefined : yield* queuedBy(recipient, request)
          if (before !== undefined) return (yield* inboxIn([before]))[0]
          if (!(yield* liveRecipient(recipient))) return undefined
          return yield* queueSend(recipient, sender, message, request)
        }),
      ).pipe(Effect.orDie),

    insertNoticeTo: (recipient: string, message: string) => tx(tellSender(recipient, message)).pipe(Effect.orDie),

    sendToOrigin: (sessionId: string, target: string, message: string, request?: string) =>
      tx(
        Effect.gen(function* () {
          const origin = yield* origins(sessionId)
          const creator = origin?.reportTo
          if (!origin?.peer || !creator || target.length < 8 || !creator.startsWith(target)) return undefined
          if (request !== undefined && (yield* queuedBy(sessionId, request)) !== undefined) return true
          const [from] = yield* sql<{ name: string }>`SELECT name FROM session WHERE id = ${sessionId}`
          const written = yield* queueForPeer(origin.peer, creator, {
            sessionId,
            kind: "notice",
            content: envelope(
              "agent-message",
              [
                ["agent-id", sessionId],
                ["title", from?.name ?? ""],
              ],
              ["message", message],
            ),
          })
          if (!written) return false
          yield* queueInbox({
            recipient: sessionId,
            kind: "send",
            sender: sessionId,
            content: message,
            status: "dropped",
            request,
          })
          return true
        }),
      ).pipe(Effect.orDie),

    failLeased: (ids: ReadonlyArray<number>) =>
      tx(
        Effect.gen(function* () {
          const unsigned = sql`kind = 'send' AND sender_session_id IS NULL`
          yield* moveInbox(sql`${sql.in("id", ids)} AND status = 'delivering' AND ${unsigned}`, "pending")
          const failed = yield* moveInbox(sql`${sql.in("id", ids)} AND status = 'delivering'`, "failed")
          yield* tellSendersOf(
            failed,
            "the main agent stopped before it took the message; it may or may not have arrived",
          )
        }),
      ).pipe(Effect.orDie),

    queuedBy: (sessionId: string, request: string) =>
      queuedBy(sessionId, request).pipe(
        Effect.map((id) => id !== undefined),
        Effect.orDie,
      ),

    inboxParties: (inboxId: number) =>
      sql<{
        recipient: string | null
        sender: string | null
      }>`SELECT recipient_session_id AS recipient, sender_session_id AS sender FROM inbox WHERE id = ${inboxId}`.pipe(
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
            WHERE (recipient_session_id = ${id} OR sender_session_id = ${id}) AND status IN ('pending', 'delivering')
            LIMIT 1`
          if (waiting.length > 0) return false
          yield* updateSession(id, { metadata: { ...s.metadata, archived: true, removed: true } })
          return true
        }),
      ).pipe(Effect.orDie),

    closeTurn: (id: string, end: TurnState, patch: SessionPatch) =>
      tx(updateSession(id, { turnState: end, ...patch })).pipe(Effect.orDie),

    linkTask: (id: string) =>
      tx(
        Effect.gen(function* () {
          const turn = yield* openTurn(id)
          if (turn !== undefined) yield* linkTask(id, turn, yield* now)
        }),
      ).pipe(Effect.orDie),

    untakenTask: (id: string) => reads.untakenTask(id).pipe(Effect.orDie),

    turnTaken: (id: string) =>
      Effect.gen(function* () {
        const turn = yield* openTurn(id)
        if (turn === undefined) return false
        const [row] = yield* sql<{ taken: number }>`SELECT (t.typed IS NOT NULL
            OR EXISTS (SELECT 1 FROM inbox i WHERE i.turn_id = t.id)) AS taken
          FROM turn t WHERE t.id = ${turn}`
        return row?.taken === 1
      }).pipe(Effect.orDie),

    latestRoundAt: (sessionId: string) =>
      sql<{ at: number | null }>`SELECT max(max(started_at, coalesce(ended_at, 0))) AS at FROM turn
        WHERE session_id = ${sessionId}`.pipe(
        Effect.map((rows) => rows[0]?.at ?? undefined),
        Effect.orDie,
      ),

    limitedSince: (sessionId: string, at: number) =>
      sql<{ harness: string; provider: string | null }>`SELECT harness, provider FROM process
        WHERE session_id = ${sessionId} AND end_reason = 'limited' AND ended_at >= ${at}
        ORDER BY id`.pipe(Effect.orDie),

    rescheduleSource: (id: string) => reads.rescheduleSource(id).pipe(Effect.orDie),

    beginUserTurn: (id: string, text: string, patch: SessionPatch) =>
      tx(
        Effect.gen(function* () {
          if ((yield* openTurn(id)) !== undefined) return false
          const at = patch.turnPromptedAt ?? (yield* now)
          const { turnState: _s, turnPromptedAt: _a, ...rest } = patch
          yield* startTurn(id, at, text)
          yield* updateSession(id, rest)
          return true
        }),
      ).pipe(Effect.orDie),

    markWorking: (id: string) =>
      tx(
        Effect.gen(function* () {
          const turn = yield* openTurn(id)
          if (turn === undefined) return
          const reported =
            yield* sql`SELECT 1 FROM event WHERE session_id = ${id} AND type = 'turn.reported' AND seq > ${turn} LIMIT 1`
          if (reported.length === 0) yield* updateSession(id, { status: "working" })
        }),
      ).pipe(Effect.orDie),

    reportTurn: (id: string, end: TurnEnded) =>
      tx(
        Effect.gen(function* () {
          const process = yield* currentProcessId(id)
          yield* emit(TurnReported, {
            sessionId: id,
            at: end.at,
            data: {
              ...(process === undefined ? {} : { process }),
              harness: end.harness,
              text: end.text,
              ...(end.error ? { error: end.error } : {}),
              ...(end.conversationId ? { conversation: end.conversationId } : {}),
              ...(end.interrupted ? { interrupted: true } : {}),
            },
          })
        }),
      ).pipe(Effect.orDie),

    latestReport: (id: string, fence: "ready" | "start") => reads.latestReport(id, fence).pipe(Effect.orDie),

    finishTurn: (id: string, end: TurnEnd, patch: SessionPatch, row: NewInboxRow, at?: number) =>
      tx(
        Effect.gen(function* () {
          const stamp = at === undefined ? undefined : Math.max(at, yield* now)
          const inserted = yield* insertInboxRow(row, row.kind === "result" ? end : undefined, stamp)
          const { turnState: _, ...rest } = patch
          yield* updateSession(id, row.kind === "result" ? rest : patch)
          return inserted
        }),
      ).pipe(Effect.orDie),

    pendingInbox: (sessionId: string) => findSend(sessionId, "pending").pipe(Effect.orDie),

    inboxWithStatus: (sessionId: string, status: InboxStatus) => findSend(sessionId, status).pipe(Effect.orDie),

    coordinatorPending: (projectIdValue: string) =>
      inbox(
        sql`m.kind != 'task' AND m.status = 'pending' AND m.recipient_session_id = ${entryOf(projectIdValue)}`,
      ).pipe(Effect.orDie),

    releaseLeased: (projectIdValue: string, ids: ReadonlyArray<number>) =>
      ids.length === 0
        ? Effect.succeed([] as ReadonlyArray<number>)
        : moveInbox(
            sql`${sql.in("id", ids)} AND status = 'delivering' AND recipient_session_id = ${entryOf(projectIdValue)}`,
            "pending",
          ).pipe(Effect.orDie),

    settleLeased: (projectIdValue: string, ids: ReadonlyArray<number>, release: ReadonlyArray<number>) =>
      tx(
        Effect.gen(function* () {
          const main = entryOf(projectIdValue)
          if (release.length > 0)
            yield* moveInbox(
              sql`${sql.in("id", release)} AND status = 'delivering' AND recipient_session_id = ${main}`,
              "pending",
            )
          if (ids.length === 0) return [] as ReadonlyArray<InboxRow>
          const done = yield* moveInbox(
            sql`${sql.in("id", ids)} AND status IN ('delivering', 'pending') AND recipient_session_id = ${main}`,
            "delivered",
          )
          return done.length === 0 ? [] : yield* inboxIn(done)
        }),
      ).pipe(Effect.orDie),

    recoverDelivering: (
      pollHarnesses: ReadonlyArray<string>,
      notice: (sessionId: string, messages: ReadonlyArray<string>) => string,
    ) =>
      tx(
        Effect.gen(function* () {
          const polling = sql`recipient_session_id IN (SELECT s.id FROM session s
              JOIN project q ON q.entry_session_id = s.id
              JOIN process p ON p.id = s.process_id
              WHERE ${pollHarnesses.length === 0 ? sql`0` : sql`p.harness IN ${sql.in(pollHarnesses)}`})`
          const toEntry = sql`EXISTS (SELECT 1 FROM project q WHERE q.entry_session_id = recipient_session_id)`
          const claimed = sql`status = 'delivering' AND ${toEntry}`
          yield* moveInbox(sql`${claimed} AND (${polling} OR (kind = 'send' AND sender_session_id IS NULL))`, "pending")
          const lost = yield* moveInbox(claimed, "failed")
          yield* tellSendersOf(
            lost,
            "vibestd stopped while handing it to the main agent; it may or may not have arrived",
          )
          const cut = yield* sql<{
            id: number
            recipient: string
            sender: string | null
            content: string
          }>`SELECT id, recipient_session_id AS recipient,
              CASE WHEN kind = 'send' THEN sender_session_id END AS sender, content FROM inbox
            WHERE status = 'delivering' AND NOT ${toEntry} ORDER BY id`
          const bySenderAndSession = new Map<string, Array<(typeof cut)[number]>>()
          for (const row of cut) {
            const key = `${row.sender ?? ""}\n${row.recipient}`
            bySenderAndSession.set(key, [...(bySenderAndSession.get(key) ?? []), row])
          }
          for (const rows of bySenderAndSession.values()) {
            const { sender, recipient } = rows[0]!
            yield* moveInbox(
              sql.in(
                "id",
                rows.map((r) => r.id),
              ),
              "failed",
            )
            const message = notice(
              recipient,
              rows.map((r) => r.content),
            )
            if (sender !== null) yield* tellSender(sender, message)
            else yield* insertInboxRow({ sessionId: recipient, kind: "notice", message, details: {} })
          }
        }),
      ).pipe(Effect.orDie),

    sendingInbox: inbox(sql`m.status = 'delivering'`).pipe(
      Effect.map((rows) => rows.map((r) => ({ id: r.id, sessionId: r.recipient ?? r.sender ?? "", kind: r.kind }))),
      Effect.orDie,
    ),

    pendingProjects: sql<{
      project: string
    }>`SELECT DISTINCT s.project_id AS project FROM inbox m JOIN session s ON s.id = m.recipient_session_id
      WHERE m.status = 'pending' AND m.kind != 'task'
        AND m.recipient_session_id = (SELECT entry_session_id FROM project WHERE id = s.project_id)`.pipe(
      Effect.map((rows) => rows.map((r) => r.project)),
      Effect.orDie,
    ),

    dropWaiting: (projectIdValue: string, guard?: { readonly runtime: string; readonly address: string } | "absent") =>
      tx(dropWaiting(projectIdValue, guard)).pipe(Effect.asVoid, Effect.orDie),

    claim: (
      ids: ReadonlyArray<number>,
      guard?: {
        readonly projectId: string
        readonly runtime: string
        readonly address: string
        readonly harnessId?: string
      },
    ) =>
      Effect.gen(function* () {
        if (ids.length === 0) return [] as ReadonlyArray<number>
        if (guard) {
          const [main] = yield* findCoordinators(guard.projectId)
          if (
            !main?.runtime ||
            !main.address ||
            main.runtime !== guard.runtime ||
            encodeAddress(main.address) !== guard.address ||
            (guard.harnessId !== undefined && guard.harnessId !== "" && main.harnessId !== guard.harnessId)
          )
            return [] as ReadonlyArray<number>
        }
        return yield* moveInbox(sql`${sql.in("id", ids)} AND status = 'pending'`, "delivering")
      }).pipe(Effect.orDie),

    transitionInbox: (ids: ReadonlyArray<number>, status: InboxStatus, from: InboxStatus) =>
      (ids.length === 0
        ? Effect.succeed([] as ReadonlyArray<number>)
        : moveInbox(sql`${sql.in("id", ids)} AND status = ${storedStatus(from)}`, storedStatus(status))
      ).pipe(Effect.orDie),

    setInboxStatus: (ids: ReadonlyArray<number>, status: InboxStatus, from?: InboxStatus) =>
      Effect.gen(function* () {
        if (ids.length === 0) return [] as ReadonlyArray<InboxRow>
        const moved = yield* moveInbox(
          sql`${sql.in("id", ids)}${from ? sql` AND status = ${storedStatus(from)}` : sql``}`,
          storedStatus(status),
        )
        return moved.length === 0 ? [] : yield* inboxIn(moved)
      }).pipe(Effect.orDie),

    latestInbox: (sessionId: string, kind: InboxKind) =>
      (kind === "send"
        ? inbox(sql`m.recipient_session_id = ${sessionId} AND m.kind = 'send'`, sql`m.id DESC LIMIT 1`)
        : inbox(sql`m.kind = ${kind} AND m.sender_session_id = ${sessionId}`, sql`m.id DESC LIMIT 1`)
      ).pipe(
        Effect.map((rows) => rows[0]),
        Effect.orDie,
      ),

    latestAnswer: (sessionId: string) =>
      sql<{
        turn: number
        status: string
        text: string | null
        failure: string | null
        endedAt: number
      }>`SELECT id AS turn, status, answer AS text, failure, ended_at FROM turn
        WHERE session_id = ${sessionId} AND status IS NOT NULL ORDER BY id DESC LIMIT 1`.pipe(
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
