import { type InboxKind } from "@vibest/schema/event"
import { InboxRow, InboxStatus, type TurnState } from "@vibest/schema/session"
import { Effect } from "effect"

import { encodeAddress, failureOf, storedStatus, type SessionPatch, type NewInboxRow, type TurnEnd } from "./db-rows.ts"
import type { Store } from "./db-store.ts"
import { envelope, type TurnEnded } from "./results.ts"

export const inboxMethods = (store: Store) => {
  const {
    sql,
    reads,
    addressedCreator,
    now,
    tx,
    findSession,
    liveRecipient,
    queueSend,
    tellSender,
    tellSendersOf,
    queueForPeer,
    origins,
    currentProcess,
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
    endTurn,
    updateSession,
    dropWaiting,
    prompted,
  } = store
  const queuedBy = reads.queuedBy
  const observable = (id: string) =>
    sql<{ ok: number }>`SELECT 1 AS ok FROM session s
      WHERE s.id = ${id} AND s.role != 'main'
        AND NOT EXISTS (SELECT 1 FROM project q WHERE q.entry_session_id = s.id)`.pipe(
      Effect.map((rows) => rows.length > 0),
    )
  return {
    insertInbox: (row: NewInboxRow) => tx(insertInboxRow(row)).pipe(Effect.orDie),

    insertSend: (recipient: string, message: string, request?: string, sender?: string) =>
      tx(
        Effect.gen(function* () {
          if (sender !== undefined) {
            const from = yield* addressedCreator(sender)
            const to = yield* addressedCreator(recipient)
            if (from !== recipient && to !== sender) return undefined
          }
          const before = request === undefined ? undefined : yield* queuedBy(recipient, request)
          if (before !== undefined) return (yield* inboxIn([before]))[0]
          if (!(yield* liveRecipient(recipient))) return undefined
          return yield* queueSend(recipient, sender, message, request)
        }),
      ).pipe(Effect.orDie),

    insertNoticeTo: (recipient: string, message: string) => tx(tellSender(recipient, message)).pipe(Effect.orDie),

    sendToOrigin: (sessionId: string, target: string, message: string) =>
      tx(
        Effect.gen(function* () {
          const origin = yield* origins(sessionId)
          const creator = origin?.reportTo
          if (!origin?.peer || !creator || target.length < 8 || !creator.startsWith(target)) return undefined
          const [from] = yield* sql<{ name: string }>`SELECT name FROM session WHERE id = ${sessionId}`
          const written = yield* queueForPeer(origin.peer, creator, {
            sessionId,
            content: envelope(
              "agent-message",
              [
                ["agent-id", sessionId],
                ["title", from?.name ?? ""],
              ],
              ["message", message],
            ),
          })
          return written
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
          if ((yield* openTurn(id)) !== undefined) return false
          yield* updateSession(id, { metadata: { ...s.metadata, archived: true, removed: true } })
          return true
        }),
      ).pipe(Effect.orDie),

    openTurn: (id: string) => openTurn(id).pipe(Effect.orDie),

    beginTurn: (id: string, at: number) =>
      tx(
        Effect.gen(function* () {
          const open = yield* openTurn(id)
          if (open !== undefined) return { turn: open, opened: false }
          return { turn: yield* startTurn(id, at), opened: true }
        }),
      ).pipe(Effect.orDie),

    stampTurn: (id: string, turn: number, at: number) =>
      Effect.gen(function* () {
        if ((yield* openTurn(id)) !== turn) return false
        prompted.set(turn, at)
        return true
      }).pipe(Effect.orDie),

    closeTurn: (
      id: string,
      turn: number,
      status: Exclude<TurnState, "none" | "open">,
      options: { readonly failure?: string; readonly notice?: string } = {},
    ) =>
      tx(
        Effect.gen(function* () {
          if ((yield* openTurn(id)) !== turn) return false
          const failure = failureOf(options.failure)
          yield* endTurn(id, { status, ...(failure === undefined ? {} : { failure }) })
          if (options.notice !== undefined) yield* insertInboxRow({ sessionId: id, message: options.notice })
          return true
        }),
      ).pipe(Effect.orDie),

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

    limitedSince: (sessionId: string, at: number) =>
      sql<{ harness: string; provider: string | null }>`SELECT harness, provider FROM process
        WHERE session_id = ${sessionId} AND end_reason = 'limited' AND ended_at >= ${at}
        ORDER BY id`.pipe(Effect.orDie),

    rescheduleSource: (id: string) => reads.rescheduleSource(id).pipe(Effect.orDie),

    startObserved: (id: string, typed: string | undefined, at: number) =>
      tx(
        Effect.gen(function* () {
          if (!(yield* observable(id))) return
          const open = (yield* openTurn(id)) ?? (typed ? yield* startTurn(id, at, typed) : undefined)
          if (open !== undefined) yield* updateSession(id, { status: "working" })
        }),
      ).pipe(Effect.orDie),

    endObserved: (id: string, end: TurnEnded) =>
      tx(
        Effect.gen(function* () {
          if (!(yield* observable(id))) return undefined
          const current = yield* currentProcess(id)
          if (current === undefined || current.start.harness !== end.harness) return undefined
          if (end.needsReady && current.readyAt === null) return undefined
          if ((yield* openTurn(id)) === undefined && end.status === "interrupted") return undefined
          const failure = failureOf(end.failure)
          yield* endTurn(
            id,
            {
              status: end.status,
              ...(failure === undefined ? {} : { failure }),
              ...(end.conversation === undefined || end.conversation === current.conversation
                ? {}
                : { conversation: end.conversation }),
              reply: end.reply,
            },
            end.at,
          )
          yield* updateSession(id, { status: "idle" })
          if (end.status === "failed" && !end.limited)
            yield* insertInboxRow(
              { sessionId: id, message: `${id}'s turn ended with an error: ${end.failure}` },
              end.at,
            )
          return end.status
        }),
      ).pipe(Effect.orDie),

    endTurn: (id: string, end: TurnEnd, patch: SessionPatch, notice: string | undefined, at?: number) =>
      tx(
        Effect.gen(function* () {
          const stamp = at === undefined ? undefined : Math.max(at, yield* now)
          yield* endTurn(id, end, stamp)
          const { turnState: _, ...rest } = patch
          yield* updateSession(id, rest)
          if (notice !== undefined) yield* insertInboxRow({ sessionId: id, message: notice }, stamp)
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
            else yield* insertInboxRow({ sessionId: recipient, message })
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

    setInboxStatus: (ids: ReadonlyArray<number>, status: InboxStatus, from?: InboxStatus, into?: number) =>
      Effect.gen(function* () {
        if (ids.length === 0) return [] as ReadonlyArray<InboxRow>
        const moved = yield* moveInbox(
          sql`${sql.in("id", ids)}${from ? sql` AND status = ${storedStatus(from)}` : sql``}`,
          storedStatus(status),
          into,
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
