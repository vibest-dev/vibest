import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  return {
    sessionDirectory: Effect.fn("Db.session.sessionDirectory")((id: string) =>
      sql<{ directory: string }>`SELECT directory FROM session WHERE id = ${id}`.pipe(
        Effect.map((rows) => rows[0]?.directory),
        Effect.orDie,
      ),
    ),

    worktreeSessions: Effect.fn("Db.session.worktreeSessions")(() =>
      sql<{
        id: string
        projectId: string
        name: string
        directory: string
        endedAt: number | null
      }>`SELECT id, project_id, name, directory, ended_at FROM session WHERE directory != ''`.pipe(Effect.orDie),
    ),

    startedByRemote: Effect.fn("Db.session.startedByRemote")((id: string) =>
      sql`SELECT 1 FROM session WHERE id = ${id} AND origin_remote IS NOT NULL`.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.orDie,
      ),
    ),

    liveSharers: Effect.fn("Db.session.liveSharers")((id: string) =>
      sql<{ id: string }>`SELECT o.id FROM session o JOIN session s ON s.id = ${id}
        WHERE o.id != s.id AND o.directory = s.directory AND s.directory != '' AND o.ended_at IS NULL
        ORDER BY o.id`.pipe(
        Effect.map((rows) => rows.map((r) => r.id)),
        Effect.orDie,
      ),
    ),

    earlierSharer: Effect.fn("Db.session.earlierSharer")((id: string) =>
      sql<{ id: string }>`SELECT o.id FROM session o JOIN session s ON s.id = ${id}
        WHERE o.id != s.id AND o.directory = s.directory AND s.directory != ''
          AND (o.created_at, o.rowid) < (s.created_at, s.rowid)
        ORDER BY o.created_at, o.rowid LIMIT 1`.pipe(
        Effect.map((rows) => rows[0]?.id),
        Effect.orDie,
      ),
    ),

    sessionIdentity: Effect.fn("Db.session.sessionIdentity")((id: string) =>
      sql<{
        id: string
        projectId: string
        agent: string
        directory: string
        harness: string
        entry: number
      }>`SELECT a.id, a.project_id, a.agent, a.directory,
          coalesce(p.harness, '') AS harness,
          q.entry_session_id = a.id AS entry
        FROM session a JOIN project q ON q.id = a.project_id
        LEFT JOIN process p ON p.session_id = a.id AND p.id = a.process_id
        WHERE a.id = ${id}`.pipe(
        Effect.map((rows) => (rows[0] === undefined ? undefined : { ...rows[0], entry: rows[0].entry === 1 })),
        Effect.orDie,
      ),
    ),
  }
})
