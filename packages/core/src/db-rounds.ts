// The message/round SQL (schema.md Message): one `working` message per session is the open round; a result file's
// mtime is compared against the newest round's times, so the same file is not delivered twice. The Db service keeps
// its interface; db.ts wires these in.
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"

export const roundSql = (sql: SqlClient.SqlClient, now: Effect.Effect<number>) => {
  const ROUND_STATUS = ["completed", "failed", "interrupted", "lost", "not_started"] as const
  const roundStatus = (status: unknown) =>
    typeof status === "string" && (ROUND_STATUS as readonly string[]).includes(status) ? status : "completed"

  /** Inbox rows handed over since this session's last round, oldest first. One merged send is all of them. */
  const roundRows = (sessionId: string) =>
    sql<{ id: number; content: string }>`SELECT id, content FROM inbox
      WHERE recipient_session_id = ${sessionId} AND delivery_status IN ('delivering', 'delivered')
      AND id > coalesce((SELECT max(inbox_id) FROM message WHERE session_id = ${sessionId}), 0)
      ORDER BY id ASC`

  /**
   * The same joined text a merged send pastes. `inboxId` is the last row: `roundRows` starts after it, so the next round
   * does not take this batch again. None: the user typed, input ''.
   */
  const joinedRound = (rows: ReadonlyArray<{ readonly id: number; readonly content: string }>) =>
    rows.length === 0 ? undefined : { inboxId: rows.at(-1)!.id, input: rows.map((row) => row.content).join("\n\n") }

  /**
   * Open a round for `sessionId`. Its input is every inbox row delivered since its last round, joined the way they are
   * pasted (schema.md Inbox: delivering a row opens a message). None such: the user typed into its pane, input ''.
   */
  const openRound = (sessionId: string, startedAt: number) =>
    Effect.gen(function* () {
      const opener = joinedRound(yield* roundRows(sessionId))
      yield* sql`INSERT INTO message ${sql.insert({
        sessionId, ...(opener ? { inboxId: opener.inboxId } : {}), input: opener?.input ?? "", status: "working", startedAt,
      })}`
    })

  /** A round opened before its rows were claimed (still ''): bind the joined text and the last row once they are delivering. */
  const bindOpenRound = (sessionId: string) =>
    Effect.gen(function* () {
      const [working] = yield* sql<{ id: number; inboxId: number | null; input: string }>`SELECT id, inbox_id, input FROM message
        WHERE session_id = ${sessionId} AND status = 'working' LIMIT 1`
      if (!working || working.inboxId != null || working.input !== "") return
      const opener = joinedRound(yield* roundRows(sessionId))
      if (!opener) return
      yield* sql`UPDATE message SET inbox_id = ${opener.inboxId}, input = ${opener.input} WHERE id = ${working.id}`
    })

  /** Close this session's open round — or insert one when the round was never opened — and return that message. */
  const closeRound = (sessionId: string, output: string, status: string, metadata: Readonly<Record<string, unknown>>) =>
    Effect.gen(function* () {
      const at = yield* now
      const meta = JSON.stringify(metadata)
      const updated = yield* sql<{ id: number }>`UPDATE message SET output = ${output}, status = ${status}, metadata = ${meta}, ended_at = ${at}
        WHERE id = (SELECT max(id) FROM message WHERE session_id = ${sessionId} AND status = 'working') RETURNING id`
      if (updated[0]) return updated[0].id
      const [created] = yield* sql<{ id: number }>`INSERT INTO message ${sql.insert({
        sessionId, input: "", output, status, metadata: meta, startedAt: at, endedAt: at,
      })} RETURNING id`
      return created!.id
    })

  /** Latest time on any message. Undefined: no round yet. A result file that is not newer was already delivered. */
  const latestRoundAt = (sessionId: string) =>
    sql<{ at: number | null }>`SELECT max(max(started_at, coalesce(ended_at, 0))) AS at FROM message WHERE session_id = ${sessionId}`.pipe(
      Effect.map((rows) => {
        const at = rows[0]?.at
        return at == null ? undefined : at
      }),
    )

  /** The newest message ends no earlier than `at`, so that result file is not newer than the round it closed. */
  const coverRound = (sessionId: string, at: number) =>
    sql`UPDATE message SET ended_at = ${at}
      WHERE id = (SELECT max(id) FROM message WHERE session_id = ${sessionId}) AND coalesce(ended_at, 0) < ${at}`.pipe(Effect.asVoid)

  /**
   * What a usage-limit move can resend, and who asked. `working` is the open round's input (empty when that round
   * has none, or there is none). `delivered`, used when that input is empty, is the trailing run of delivered user
   * or parent rows from the same sender that are newer than any round's linked inbox row (the batch a queued
   * delivery joined), oldest first, joined with a blank line. One row stays one row. `parentSessionId` is unset
   * when the user started the session. An unknown id is empty.
   */
  const rescheduleSource = (id: string) =>
    Effect.gen(function* () {
      const [head] = yield* sql<{ working: string | null; linked: number | null; parentSessionId: string | null }>`SELECT
        (SELECT m.input FROM message m WHERE m.session_id = s.id AND m.status = 'working' ORDER BY m.id DESC LIMIT 1) AS working,
        (SELECT max(m.inbox_id) FROM message m WHERE m.session_id = s.id) AS linked,
        s.parent_session_id AS parentSessionId
        FROM session s WHERE s.id = ${id}`
      if (head === undefined) return { working: "", delivered: "", parentSessionId: undefined }
      const rows = yield* sql<{ content: string; senderType: string; senderId: string | null }>`SELECT content,
        sender_type AS senderType, sender_id AS senderId FROM inbox
        WHERE recipient_session_id = ${id} AND delivery_status = 'delivered' AND id > ${head.linked ?? 0}
          AND (sender_type = 'user' OR (sender_type = 'session' AND sender_id = (SELECT parent_session_id FROM session WHERE id = ${id})))
        ORDER BY id`
      const last = rows.at(-1)
      let from = rows.length
      if (last !== undefined) {
        from = rows.length - 1
        while (from > 0 && rows[from - 1]!.senderType === last.senderType && rows[from - 1]!.senderId === last.senderId) from--
      }
      return {
        working: head.working ?? "",
        delivered: rows.slice(from).map((row) => row.content).join("\n\n"),
        parentSessionId: head.parentSessionId ?? undefined,
      }
    })

  return { roundStatus, openRound, bindOpenRound, closeRound, latestRoundAt, coverRound, rescheduleSource }
}
