import { SessionLinked, SessionUnlinked } from "@vibest/schema/event"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import { Bus } from "../bus.ts"

export type SessionEdge = {
  readonly from: string
  readonly to: string
}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const { publish, transaction: tx } = yield* Bus.Service

  const mutateEdges = (edges: ReadonlyArray<readonly [string, string]>, add: boolean) =>
    tx(
      Effect.gen(function* () {
        const out: Array<SessionEdge> = []

        for (const [from, to] of edges) {
          if (from === to) continue

          const exists =
            (yield* sql`SELECT 1 FROM session_edge WHERE from_session_id = ${from} AND to_session_id = ${to}`).length >
            0

          if (add && !exists) yield* publish(SessionLinked, { sessionId: from, data: { to } })
          else if (!add && exists) yield* publish(SessionUnlinked, { sessionId: from, data: { to } })

          out.push({ from, to })
        }

        return out
      }),
    ).pipe(Effect.orDie)

  return {
    sessionParents: Effect.fn("Db.session.sessionParents")((ids: ReadonlyArray<string>) =>
      (ids.length === 0
        ? Effect.succeed<ReadonlyArray<{ id: string; parentSessionId: string | null }>>([])
        : sql<{ id: string; parentSessionId: string | null }>`SELECT id, parent_session_id FROM session
            WHERE ${sql.in("id", ids)}`
      ).pipe(
        Effect.map((rows) => new Map(rows.map((row) => [row.id, row.parentSessionId]))),
        Effect.orDie,
      ),
    ),

    sessionEdges: Effect.fn("Db.session.sessionEdges")((ids: ReadonlyArray<string>) =>
      (ids.length === 0
        ? Effect.succeed<ReadonlyArray<{ fromSessionId: string; toSessionId: string }>>([])
        : sql<{ fromSessionId: string; toSessionId: string }>`SELECT from_session_id, to_session_id
            FROM session_edge WHERE ${sql.in("from_session_id", ids)} ORDER BY to_session_id`
      ).pipe(
        Effect.map((rows) => {
          const byFrom = new Map<string, Array<string>>()

          for (const row of rows) {
            const list = byFrom.get(row.fromSessionId)

            if (list === undefined) byFrom.set(row.fromSessionId, [row.toSessionId])
            else list.push(row.toSessionId)
          }

          return byFrom
        }),
        Effect.orDie,
      ),
    ),

    linkedTargets: Effect.fn("Db.session.linkedTargets")((id: string, exclude?: string) =>
      sql<{ id: string; name: string }>`SELECT e.to_session_id AS id, s.name
        FROM session_edge e
        JOIN session s ON s.id = e.to_session_id
        WHERE e.from_session_id = ${id} AND s.ended_at IS NULL
          ${exclude === undefined ? sql`` : sql`AND e.to_session_id != ${exclude}`}
        ORDER BY s.created_at, s.rowid`.pipe(
        Effect.map((rows) =>
          rows.map((row) => ({
            id: row.id,
            label: row.name ? `agent ${row.name}` : row.id,
          })),
        ),
        Effect.orDie,
      ),
    ),

    linkSessions: Effect.fn("Db.session.linkSessions")((edges: ReadonlyArray<readonly [string, string]>) =>
      mutateEdges(edges, true),
    ),

    unlinkSessions: Effect.fn("Db.session.unlinkSessions")((edges: ReadonlyArray<readonly [string, string]>) =>
      mutateEdges(edges, false),
    ),
  }
})
