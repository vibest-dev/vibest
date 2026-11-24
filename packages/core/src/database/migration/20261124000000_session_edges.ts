import { Effect, Schema } from "effect"
import type { SqlClient } from "effect/sql"

const optional = <S extends Schema.Top>(schema: S) => Schema.optionalKey(schema)

const Created = Schema.Struct({
  project: Schema.String,
  agent: Schema.String,
  name: Schema.String,
  directory: Schema.String,
  parent: optional(Schema.String),
  origin: optional(Schema.Struct({ peer: Schema.String, project: Schema.String, session: optional(Schema.String) })),
  message: optional(Schema.Number),
  team: optional(Schema.String),
})

type CreatedRow = {
  readonly position: number
  readonly aggregate: string
  readonly at: number
  readonly data: string
}

type SessionMeta = {
  readonly id: string
  readonly project: string
  readonly parent: string | undefined
  readonly team: string | undefined
  readonly at: number
}

const decodeCreated = (data: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(Created))(data).pipe(Effect.orDie)

export const migration = {
  id: "20261124000000_session_edges",
  up: (tx: SqlClient.SqlClient) =>
    Effect.gen(function* () {
      const rows = yield* tx<CreatedRow>`SELECT position, aggregate, at, data FROM event
        WHERE type = 'session.created' ORDER BY position`

      const sessions = new Map<string, SessionMeta>()
      const teams = new Map<string, Array<SessionMeta>>()

      for (const row of rows) {
        const parsed = yield* decodeCreated(row.data)

        if (parsed.team !== undefined) {
          const { team: _team, ...rest } = parsed
          yield* tx`UPDATE event SET data = ${JSON.stringify(rest)} WHERE position = ${row.position}`
        }

        const meta: SessionMeta = {
          id: row.aggregate,
          project: parsed.project,
          parent: parsed.parent,
          team: parsed.team,
          at: row.at,
        }

        sessions.set(row.aggregate, meta)

        if (parsed.team !== undefined && parsed.team !== "") {
          const key = `${parsed.project}\0${parsed.team}`
          const group = teams.get(key)

          if (group === undefined) teams.set(key, [meta])
          else group.push(meta)
        }
      }

      const seen = new Set<string>()
      const edgesByFrom = new Map<string, Array<{ readonly to: string; readonly at: number }>>()

      const addEdge = (from: string, to: string, at: number) => {
        if (from === to) return
        const key = `${from}\0${to}`

        if (seen.has(key)) return
        seen.add(key)
        const list = edgesByFrom.get(from)

        if (list === undefined) edgesByFrom.set(from, [{ to, at }])
        else list.push({ to, at })
      }

      for (const meta of sessions.values()) {
        if (meta.parent === undefined) continue
        const parent = sessions.get(meta.parent)

        if (parent === undefined || parent.project !== meta.project) continue
        addEdge(parent.id, meta.id, meta.at)
        addEdge(meta.id, parent.id, meta.at)
      }

      for (const group of teams.values()) {
        for (const a of group) {
          for (const b of group) {
            if (a.id === b.id) continue
            addEdge(a.id, b.id, Math.max(a.at, b.at))
          }
        }
      }

      for (const [from, edges] of edgesByFrom) {
        const [seqRow] = yield* tx<{ maxSeq: number }>`SELECT coalesce(max(seq), 0) AS maxSeq
          FROM event WHERE aggregate = ${from}`

        let seq = seqRow?.maxSeq ?? 0

        for (const edge of edges) {
          seq += 1
          yield* tx`INSERT INTO event (aggregate, seq, at, type, data)
            VALUES (${from}, ${seq}, ${edge.at}, 'session.linked', ${JSON.stringify({ to: edge.to })})`
        }
      }
    }),
}
