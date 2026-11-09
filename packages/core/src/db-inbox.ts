import { InboxKind, InboxRow, InboxStatus, TurnState } from "@vibest/schema/session"
import { Effect } from "effect"

import {
  encodeAddress,
  storedStatus,
  type SessionPatch,
  type NewInboxRow,
  type TurnEnd,
  type TurnReport,
} from "./db-rows.ts"
import { type Store, TO_SESSION } from "./db-store.ts"
import type { HarnessId } from "./harness.ts"
import type { TurnEnded } from "./results.ts"

export const inboxMethods = (store: Store) => {
  const {
    sql,
    currentStart,
    now,
    append,
    tx,
    findSession,
    anySession,
    findCoordinators,
    inbox,
    inboxIn,
    findSend,
    entryOf,
    queuedBy,
    openTurn,
    moveInbox,
    linkTask,
    insertInboxRow,
    updateSession,
    dropWaiting,
  } = store
  return {
    insertInbox: (row: NewInboxRow) => tx(insertInboxRow(row)).pipe(Effect.orDie),

    insertSend: (sessionId: string, message: string, request?: string) =>
      tx(
        Effect.gen(function* () {
          const before = request === undefined ? undefined : yield* queuedBy(sessionId, request)
          if (before !== undefined) return (yield* inboxIn([before]))[0]
          const s = yield* findSession(sessionId)
          if (s === undefined || s.metadata.archived || s.metadata.removed) return undefined
          return yield* insertInboxRow({ sessionId, kind: "send", message, details: {} }, undefined, undefined, request)
        }),
      ).pipe(Effect.orDie),

    queuedBy: (sessionId: string, request: string) =>
      queuedBy(sessionId, request).pipe(
        Effect.map((id) => id !== undefined),
        Effect.orDie,
      ),

    archiveIfNoPending: (id: string) =>
      tx(
        Effect.gen(function* () {
          const s = yield* findSession(id)
          if (s === undefined || (yield* findSend(id, "pending")).length > 0) return false
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

    untakenTask: (id: string) =>
      sql<{ content: string }>`SELECT i.content FROM inbox i WHERE i.recipient_session_id = ${id} AND i.kind = 'task'
          AND NOT EXISTS (SELECT 1 FROM event e WHERE e.inbox_id = i.id AND e.type = 'inbox.status')
          AND NOT EXISTS (SELECT 1 FROM event te JOIN event t ON t.id = te.turn_id
            WHERE te.session_id = ${id} AND te.type = 'turn.end' AND (json_extract(t.data, '$.typed') IS NOT NULL
              OR EXISTS (SELECT 1 FROM event e WHERE e.turn_id = t.id AND e.type = 'inbox.status')))
        LIMIT 1`.pipe(
        Effect.map((rows) => rows[0]?.content),
        Effect.orDie,
      ),

    turnTaken: (id: string) =>
      Effect.gen(function* () {
        const turn = yield* openTurn(id)
        if (turn === undefined) return false
        const [row] = yield* sql<{ taken: number }>`SELECT (json_extract(t.data, '$.typed') IS NOT NULL OR EXISTS (
            SELECT 1 FROM event e WHERE e.turn_id = t.id AND e.type = 'inbox.status'
              AND json_extract(e.data, '$.to') = 'delivered')) AS taken
          FROM event t WHERE t.id = ${turn}`
        return row?.taken === 1
      }).pipe(Effect.orDie),

    latestRoundAt: (sessionId: string) =>
      sql<{ at: number | null }>`SELECT max(at) AS at FROM event WHERE session_id = ${sessionId}
        AND type IN ('turn.start', 'turn.end')`.pipe(
        Effect.map((rows) => rows[0]?.at ?? undefined),
        Effect.orDie,
      ),

    limitedSince: (sessionId: string, at: number) =>
      sql<{ harness: string; provider: string | null }>`SELECT json_extract(ps.data, '$.harness') AS harness,
          json_extract(ps.data, '$.provider') AS provider
        FROM event pe JOIN event ps ON ps.id = pe.process_id
        WHERE pe.session_id = ${sessionId} AND pe.type = 'process.end' AND json_extract(pe.data, '$.reason') = 'limited'
          AND pe.at >= ${at}
        ORDER BY pe.id`.pipe(Effect.orDie),

    rescheduleSource: (id: string) =>
      Effect.gen(function* () {
        const [head] = yield* sql<{
          parentSessionId: string | null
        }>`SELECT parent_session_id FROM session WHERE id = ${id}`
        if (head === undefined) return { working: "", delivered: "", parentSessionId: undefined }
        const open = yield* openTurn(id)
        let working = ""
        if (open !== undefined) {
          const [t] = yield* sql<{
            typed: string | null
          }>`SELECT json_extract(data, '$.typed') AS typed FROM event WHERE id = ${open}`
          const rows = yield* sql<{
            content: string
          }>`SELECT i.content FROM inbox i WHERE i.id IN (SELECT e.inbox_id FROM event e
              WHERE e.type = 'inbox.status' AND json_extract(e.data, '$.to') = 'delivered' AND e.turn_id = ${open})
            ORDER BY i.id`
          working = t?.typed ?? rows.map((r) => r.content).join("\n\n")
        }
        const [linked] = yield* sql<{ id: number | null }>`SELECT max(e.inbox_id) AS id FROM event e
          WHERE e.session_id = ${id} AND e.type = 'inbox.status' AND e.turn_id IS NOT NULL`
        const rows = yield* sql<{ content: string; sender: string | null }>`SELECT content, sender_session_id AS sender
          FROM inbox WHERE recipient_session_id = ${id} AND status = 'delivered' AND kind IN ${sql.literal(TO_SESSION)}
            AND id > ${linked?.id ?? 0}
          ORDER BY id`
        const last = rows.at(-1)
        let from = rows.length
        if (last !== undefined) {
          from = rows.length - 1
          while (from > 0 && rows[from - 1]!.sender === last.sender) from--
        }
        return {
          working,
          delivered: rows
            .slice(from)
            .map((row) => row.content)
            .join("\n\n"),
          parentSessionId: head.parentSessionId ?? undefined,
        }
      }).pipe(Effect.orDie),

    beginUserTurn: (id: string, text: string, patch: SessionPatch) =>
      tx(
        Effect.gen(function* () {
          if ((yield* openTurn(id)) !== undefined) return false
          const at = patch.turnPromptedAt ?? (yield* now)
          const { turnState: _s, turnPromptedAt: _a, ...rest } = patch
          yield* append({
            sessionId: id,
            type: "turn.start",
            processId: (yield* anySession(id))?.current?.id,
            at,
            data: { typed: text },
          })
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
            yield* sql`SELECT 1 FROM event WHERE session_id = ${id} AND type = 'turn.reported' AND id > ${turn} LIMIT 1`
          if (reported.length === 0) yield* updateSession(id, { status: "working" })
        }),
      ).pipe(Effect.orDie),

    reportTurn: (id: string, end: TurnEnded) =>
      tx(
        Effect.gen(function* () {
          const processId = (yield* anySession(id))?.current?.id
          yield* append({
            sessionId: id,
            type: "turn.reported",
            ...(processId === undefined ? {} : { processId }),
            at: end.at,
            data: {
              harness: end.harness,
              text: end.text,
              ...(end.error ? { error: end.error } : {}),
              ...(end.conversationId ? { conversation: end.conversationId } : {}),
              ...(end.interrupted ? { interrupted: true } : {}),
            },
          })
        }),
      ).pipe(Effect.orDie),

    latestReport: (id: string, fence: "ready" | "start") =>
      sql<{ id: number; at: number; data: string; consumed: number }>`SELECT r.id, r.at, r.data,
        EXISTS (SELECT 1 FROM event te WHERE te.session_id = ${id} AND te.type = 'turn.end'
          AND json_extract(te.data, '$.report') = r.id) AS consumed
        FROM event r WHERE r.session_id = ${id} AND r.type = 'turn.reported' AND r.id > ${
          fence === "start"
            ? currentStart(sql`${id}`)
            : sql`(SELECT min(e.id) FROM event e WHERE e.process_id = ${currentStart(sql`${id}`)}
                AND e.type = 'process.ready' AND json_extract(e.data, '$.pidOnly') IS NULL)`
        }
        ORDER BY r.id DESC LIMIT 1`.pipe(
        Effect.map((rows) => {
          const row = rows[0]
          if (row === undefined || row.consumed) return undefined
          const data = JSON.parse(row.data) as {
            harness?: unknown
            text?: unknown
            error?: unknown
            conversation?: unknown
            interrupted?: unknown
          }
          if (typeof data.harness !== "string") return undefined
          return {
            id: row.id,
            at: row.at,
            harness: data.harness as HarnessId,
            text: typeof data.text === "string" ? data.text : "",
            error: typeof data.error === "string" && data.error !== "" ? data.error : undefined,
            conversationId: typeof data.conversation === "string" ? data.conversation : undefined,
            interrupted: data.interrupted === true,
          } satisfies TurnReport
        }),
        Effect.orDie,
      ),

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
        sql`m.kind NOT IN ${sql.literal(TO_SESSION)} AND m.status = 'pending' AND m.recipient_session_id = ${entryOf(projectIdValue)}`,
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
            sql`${sql.in("id", ids)} AND status IN ('delivering', 'pending') AND kind NOT IN ${sql.literal(TO_SESSION)}
                AND recipient_session_id = ${main}`,
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
              JOIN event p ON p.id = ${currentStart(sql`s.id`)}
              WHERE ${pollHarnesses.length === 0 ? sql`0` : sql`json_extract(p.data, '$.harness') IN ${sql.in(pollHarnesses)}`})`
          const claimed = sql`status = 'delivering' AND kind NOT IN ${sql.literal(TO_SESSION)}`
          yield* moveInbox(sql`${claimed} AND ${polling}`, "pending")
          yield* moveInbox(claimed, "failed")
          const cut = yield* sql<{ id: number; recipient: string; content: string }>`SELECT id,
              recipient_session_id AS recipient, content FROM inbox
            WHERE status = 'delivering' AND kind IN ${sql.literal(TO_SESSION)} ORDER BY id`
          const bySession = new Map<string, Array<{ id: number; content: string }>>()
          for (const row of cut) bySession.set(row.recipient, [...(bySession.get(row.recipient) ?? []), row])
          for (const [sessionId, rows] of bySession) {
            yield* moveInbox(
              sql.in(
                "id",
                rows.map((r) => r.id),
              ),
              "failed",
            )
            yield* insertInboxRow({
              sessionId,
              kind: "notice",
              message: notice(
                sessionId,
                rows.map((r) => r.content),
              ),
              details: {},
            })
          }
        }),
      ).pipe(Effect.orDie),

    sendingInbox: inbox(sql`m.status = 'delivering'`).pipe(
      Effect.map((rows) => rows.map((r) => ({ id: r.id, sessionId: r.sessionId, kind: r.kind }))),
      Effect.orDie,
    ),

    pendingProjects: sql<{
      project: string
    }>`SELECT DISTINCT s.project_id AS project FROM inbox m JOIN session s ON s.id = m.recipient_session_id
      WHERE m.status = 'pending' AND m.kind NOT IN ${sql.literal(TO_SESSION)}`.pipe(
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

    projectOfSession: (sessionId: string) =>
      sql<{ project: string }>`SELECT project_id AS project FROM session WHERE id = ${sessionId}`.pipe(
        Effect.map((rows) => rows[0]?.project),
        Effect.orDie,
      ),
  }
}
