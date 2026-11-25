import { Effect } from "effect"
import type { SqlClient } from "effect/sql"

export const sessionReads = (sql: SqlClient.SqlClient) => ({
  sessionDirectory: Effect.fn("SessionStore.sessionDirectory")((id: string) =>
    sql<{ directory: string }>`SELECT directory FROM session WHERE id = ${id}`.pipe(
      Effect.map((rows) => rows[0]?.directory),
      Effect.orDie,
    ),
  ),

  worktreeSessions: Effect.fn("SessionStore.worktreeSessions")(() =>
    sql<{
      id: string
      projectId: string
      name: string
      directory: string
      endedAt: number | null
    }>`SELECT id, project_id, name, directory, ended_at FROM session WHERE directory != ''`.pipe(Effect.orDie),
  ),

  startedByRemote: Effect.fn("SessionStore.startedByRemote")((id: string) =>
    sql`SELECT 1 FROM session WHERE id = ${id} AND origin_remote IS NOT NULL`.pipe(
      Effect.map((rows) => rows.length > 0),
      Effect.orDie,
    ),
  ),

  liveSharers: Effect.fn("SessionStore.liveSharers")((id: string) =>
    sql<{ id: string }>`SELECT o.id FROM session o JOIN session s ON s.id = ${id}
        WHERE o.id != s.id AND o.directory = s.directory AND s.directory != '' AND o.ended_at IS NULL
        ORDER BY o.id`.pipe(
      Effect.map((rows) => rows.map((r) => r.id)),
      Effect.orDie,
    ),
  ),

  earlierSharer: Effect.fn("SessionStore.earlierSharer")((id: string) =>
    sql<{ id: string }>`SELECT o.id FROM session o JOIN session s ON s.id = ${id}
        WHERE o.id != s.id AND o.directory = s.directory AND s.directory != ''
          AND (o.created_at, o.rowid) < (s.created_at, s.rowid)
        ORDER BY o.created_at, o.rowid LIMIT 1`.pipe(
      Effect.map((rows) => rows[0]?.id),
      Effect.orDie,
    ),
  ),

  sessionIdentity: Effect.fn("SessionStore.sessionIdentity")((id: string) =>
    sql<{
      id: string
      projectId: string
      agent: string
      directory: string
      harness: string
      parentId: string | null
    }>`SELECT a.id, a.project_id, a.agent, a.directory,
          coalesce(p.harness, '') AS harness,
          a.parent_session_id AS parent_id
        FROM session a
        LEFT JOIN process p ON p.session_id = a.id AND p.id = a.process_id
        WHERE a.id = ${id}`.pipe(
      Effect.map((rows) => rows[0]),
      Effect.orDie,
    ),
  ),
})
