import { shortId } from "@vibest/schema/id"
import { SessionEvent } from "@vibest/schema/session-event"
import type { SessionRef } from "@vibest/schema/terminal"
import { Effect, Predicate } from "effect"
import { SqlClient } from "effect/sql"

import { Bus } from "../bus.ts"

export const SESSION_PREFIX = /^[0-9a-f-]{8,36}$/

export type SessionEdge = {
  readonly from: string
  readonly to: string
  readonly remote?: string | undefined
}

export interface SpawnLinks {
  readonly from?: ReadonlyArray<string> | undefined
  readonly to?: ReadonlyArray<string> | undefined
  readonly with?: ReadonlyArray<string> | undefined
}

export type EdgeSpec<R = SessionRef> =
  | { readonly _tag: "Mutual"; readonly ids: ReadonlyArray<R> }
  | { readonly _tag: "Directed"; readonly from: ReadonlyArray<R>; readonly to: ReadonlyArray<R> }
  | { readonly _tag: "Chain"; readonly ids: ReadonlyArray<R> }

export const resolveEdgeRefs = (
  edges: ReadonlyArray<{ readonly id: string; readonly remote?: string }>,
  machineByRemote: ReadonlyMap<string, string>,
): ReadonlyArray<SessionRef> =>
  edges.map((edge) =>
    edge.remote === undefined
      ? { id: edge.id }
      : { id: edge.id, machine: machineByRemote.get(edge.remote) ?? edge.remote },
  )

export const dedupePairs = <T>(
  items: ReadonlyArray<readonly [T, T]>,
  keyOf: (item: T) => string,
): ReadonlyArray<readonly [T, T]> => {
  const pairs: Array<readonly [T, T]> = []
  const seen = new Set<string>()

  for (const [from, to] of items) {
    const fk = keyOf(from)
    const tk = keyOf(to)

    if (fk === tk) continue
    const key = `${fk}\0${tk}`

    if (seen.has(key)) continue
    seen.add(key)
    pairs.push([from, to])
  }

  return pairs
}

export const expandEdgeSpec = <Ref, T, E1, E2, R>(
  spec: EdgeSpec<Ref>,
  resolve: (ref: Ref) => Effect.Effect<T, E1, R>,
  keyOf: (item: T) => string,
  fail: (message: string) => Effect.Effect<never, E2>,
): Effect.Effect<ReadonlyArray<readonly [T, T]>, E1 | E2, R> =>
  Effect.gen(function* () {
    const raw: Array<readonly [T, T]> = []

    if (Predicate.isTagged(spec, "Mutual")) {
      const resolved = yield* Effect.forEach(spec.ids, resolve)
      const unique = new Map<string, T>()

      for (const item of resolved) if (!unique.has(keyOf(item))) unique.set(keyOf(item), item)
      const items = [...unique.values()]

      if (items.length < 2) return yield* fail("give at least two distinct sessions")

      for (const a of items) for (const b of items) raw.push([a, b])

      return dedupePairs(raw, keyOf)
    }

    if (Predicate.isTagged(spec, "Directed")) {
      const from = yield* Effect.forEach(spec.from, resolve)
      const to = yield* Effect.forEach(spec.to, resolve)

      if (from.length === 0 || to.length === 0) return yield* fail("give at least one source and one target session")

      if (from.length === 1 && to.length === 1 && keyOf(from[0]!) === keyOf(to[0]!))
        return yield* fail("a session cannot target itself")

      for (const a of from) for (const b of to) raw.push([a, b])

      const pairs = dedupePairs(raw, keyOf)

      if (pairs.length === 0) return yield* fail("a session cannot target itself")

      return pairs
    }

    const items = yield* Effect.forEach(spec.ids, resolve)

    if (items.length < 2) return yield* fail("give at least two sessions for --chain")

    for (let i = 0; i + 1 < items.length; i++) {
      const a = items[i]!
      const b = items[i + 1]!

      if (keyOf(a) === keyOf(b)) return yield* fail("a session cannot target itself")
      raw.push([a, b])
    }

    return dedupePairs(raw, keyOf)
  })

export const queryRemoteEdges = (
  sql: SqlClient.SqlClient,
  fromSessionId: string,
  target: string,
  remoteId?: string,
) => {
  if (!SESSION_PREFIX.test(target)) return Effect.succeed<ReadonlyArray<{ remote: string; session: string }>>([])

  return sql<{ remote: string; session: string }>`SELECT to_remote_id AS remote, to_session_id AS session
    FROM session_edge
    WHERE from_session_id = ${fromSessionId}
      ${remoteId === undefined ? sql`AND to_remote_id != ''` : sql`AND to_remote_id = ${remoteId}`}
      AND to_session_id >= ${target} AND to_session_id < ${`${target}~`}
    ORDER BY to_session_id LIMIT 11`
}

export const sessionEdges = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const { publish, transaction: tx } = yield* Bus.Service

  const mutateEdges = (edges: ReadonlyArray<SessionEdge>, add: boolean) =>
    tx(
      Effect.gen(function* () {
        const out: Array<SessionEdge> = []

        for (const edge of edges) {
          const remote = edge.remote ?? ""

          if (remote === "" && edge.from === edge.to) continue

          const exists =
            (yield* sql`SELECT 1 FROM session_edge WHERE from_session_id = ${edge.from}
                AND to_remote_id = ${remote} AND to_session_id = ${edge.to}`).length > 0

          if (add && !exists)
            yield* publish(SessionEvent.Linked, {
              sessionId: edge.from,
              to: edge.to,
              ...(remote !== "" && { remote }),
            })
          else if (!add && exists)
            yield* publish(SessionEvent.Unlinked, {
              sessionId: edge.from,
              to: edge.to,
              ...(remote !== "" && { remote }),
            })

          out.push({ from: edge.from, to: edge.to, ...(remote !== "" && { remote }) })
        }

        return out
      }),
    ).pipe(Effect.orDie)

  return {
    sessionParents: Effect.fn("SessionStore.sessionParents")((ids: ReadonlyArray<string>) =>
      (ids.length === 0
        ? Effect.succeed<ReadonlyArray<{ id: string; parentSessionId: string | null }>>([])
        : sql<{ id: string; parentSessionId: string | null }>`SELECT id, parent_session_id FROM session
            WHERE ${sql.in("id", ids)}`
      ).pipe(
        Effect.map((rows) => new Map(rows.map((row) => [row.id, row.parentSessionId]))),
        Effect.orDie,
      ),
    ),

    sessionEdges: Effect.fn("SessionStore.sessionEdges")((ids: ReadonlyArray<string>) =>
      (ids.length === 0
        ? Effect.succeed<ReadonlyArray<{ fromSessionId: string; toRemoteId: string; toSessionId: string }>>([])
        : sql<{
            fromSessionId: string
            toRemoteId: string
            toSessionId: string
          }>`SELECT from_session_id, to_remote_id, to_session_id
            FROM session_edge WHERE ${sql.in("from_session_id", ids)} ORDER BY to_remote_id, to_session_id`
      ).pipe(
        Effect.map((rows) => {
          const byFrom = new Map<string, Array<{ readonly id: string; readonly remote?: string }>>()

          for (const row of rows) {
            const target =
              row.toRemoteId === "" ? { id: row.toSessionId } : { id: row.toSessionId, remote: row.toRemoteId }

            const list = byFrom.get(row.fromSessionId)

            if (list === undefined) byFrom.set(row.fromSessionId, [target])
            else list.push(target)
          }

          return byFrom
        }),
        Effect.orDie,
      ),
    ),

    linkedTargets: Effect.fn("SessionStore.linkedTargets")((id: string, exclude?: string) =>
      sql<{
        id: string
        remoteId: string
        name: string | null
        machine: string | null
      }>`SELECT e.to_session_id AS id, e.to_remote_id AS remote_id, s.name,
          coalesce(
            (SELECT m.name FROM machine m WHERE m.remote_id = e.to_remote_id),
            (SELECT r.name FROM remote r WHERE r.id = e.to_remote_id)
          ) AS machine
        FROM session_edge e
        LEFT JOIN session s ON e.to_remote_id = '' AND s.id = e.to_session_id
        WHERE e.from_session_id = ${id}
          AND (e.to_remote_id != '' OR (s.id IS NOT NULL AND s.ended_at IS NULL))
          ${exclude === undefined ? sql`` : sql`AND e.to_session_id != ${exclude}`}
        ORDER BY CASE WHEN e.to_remote_id = '' THEN 0 ELSE 1 END, s.created_at, s.rowid, e.to_remote_id, e.to_session_id`.pipe(
        Effect.map((rows) =>
          rows.map((row) => ({
            id: row.id,
            label:
              row.remoteId === ""
                ? row.name
                  ? `agent ${row.name}`
                  : shortId(row.id)
                : row.machine
                  ? `on ${row.machine}`
                  : "on another machine",
          })),
        ),
        Effect.orDie,
      ),
    ),

    resolveRemoteEdges: Effect.fn("SessionStore.resolveRemoteEdges")(
      (fromSessionId: string, target: string, remoteId?: string) =>
        queryRemoteEdges(sql, fromSessionId, target, remoteId).pipe(Effect.orDie),
    ),

    linkSessions: Effect.fn("SessionStore.linkSessions")((edges: ReadonlyArray<SessionEdge>) =>
      mutateEdges(edges, true),
    ),

    unlinkSessions: Effect.fn("SessionStore.unlinkSessions")((edges: ReadonlyArray<SessionEdge>) =>
      mutateEdges(edges, false),
    ),
  }
})
