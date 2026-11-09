import { randomId } from "@vibest/schema/id"
import { Effect, Option, Schema } from "effect"
import type { SqlClient, SqlError, Statement } from "effect/sql"

import type { LiveEvent } from "./bus.ts"

export const REMOTE_TABLES: ReadonlyArray<string> = [
  `CREATE TABLE IF NOT EXISTS machine (
    name         TEXT PRIMARY KEY,
    target       TEXT NOT NULL,
    vibestd_id   TEXT NOT NULL UNIQUE CHECK (length(vibestd_id) = 36),
    connected_at INTEGER NOT NULL,
    created_at   INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS peer (
    id           TEXT PRIMARY KEY CHECK (length(id) = 36),
    name         TEXT NOT NULL,
    calls_me     TEXT NOT NULL,
    connected_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS outbox (
    id         TEXT PRIMARY KEY CHECK (length(id) = 36),
    peer_id    TEXT NOT NULL REFERENCES peer (id),
    session_id TEXT NOT NULL REFERENCES session (id),
    kind       TEXT NOT NULL CHECK (kind IN ('result', 'notice')),
    content    TEXT NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS outbox_peer ON outbox (peer_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS outbox_session ON outbox (session_id)`,
]

export type MachineRow = {
  readonly name: string
  readonly target: string
  readonly vibestdId: string
  readonly connectedAt: number
  readonly createdAt: number
}

export const PeerStart = Schema.Struct({
  peer: Schema.String,
  project: Schema.String,
  parent: Schema.optional(Schema.String),
  reportTo: Schema.optional(Schema.String),
})
export type PeerStart = typeof PeerStart.Type

const decodeStart = Schema.decodeUnknownOption(Schema.fromJsonString(PeerStart))

export const peerStartOf = (sessionId: string, data: string | null) =>
  Effect.gen(function* () {
    if (data === null) return undefined
    const start = decodeStart(data)
    if (Option.isSome(start)) return start.value
    yield* Effect.logWarning(`session ${sessionId}: its peer.start event does not decode; skipped`)
    return undefined
  })

export type OutboxRow = {
  readonly id: string
  readonly sessionId: string
  readonly kind: "result" | "notice"
  readonly content: string
  readonly createdAt: number
  readonly reportTo: string
}

type Deps = {
  readonly sql: SqlClient.SqlClient
  readonly now: Effect.Effect<number>
  readonly tx: <A, E, R>(body: Effect.Effect<A, E, R>) => Effect.Effect<A, E | SqlError.SqlError, R>
  readonly notify: (event: LiveEvent) => Effect.Effect<void>
  readonly present: (project: string, recipient: string) => Effect.Effect<boolean, unknown>
  readonly queuedBy: (sessionId: string, request: string) => Effect.Effect<number | undefined, unknown>
  readonly insertInbox: (row: {
    readonly recipient: string
    readonly kind: string
    readonly sender: null
    readonly content: string
    readonly status: string
    readonly request: string
  }) => Effect.Effect<unknown, unknown>
}

export const remoteQueries = ({ sql, now, tx, notify, present, queuedBy, insertInbox }: Deps) => {
  const machineColumns = sql`name, target, vibestd_id, connected_at, created_at`

  return {
    ofPeer: (session: Statement.Fragment, scope: { readonly peer: string; readonly project: string }) =>
      sql`EXISTS (SELECT 1 FROM event pe WHERE pe.session_id = ${session} AND pe.type = 'peer.start'
        AND json_extract(pe.data, '$.peer') = ${scope.peer} AND json_extract(pe.data, '$.project') = ${scope.project})`,

    queueForPeer: (
      origin: PeerStart,
      row: {
        readonly sessionId: string
        readonly kind: string
        readonly content: string
        readonly at?: number | undefined
      },
    ) =>
      Effect.gen(function* () {
        if (origin.reportTo === undefined) return
        if ((yield* sql<{ one: number }>`SELECT 1 AS one FROM peer WHERE id = ${origin.peer}`).length === 0) return
        yield* sql`INSERT INTO outbox ${sql.insert({
          id: randomId(),
          peerId: origin.peer,
          sessionId: row.sessionId,
          kind: row.kind === "result" ? "result" : "notice",
          content: row.content,
          createdAt: row.at ?? (yield* now),
        })}`
        yield* notify({ type: "live.outbox", peerId: origin.peer })
      }),

    queries: {
      machines: sql<MachineRow>`SELECT ${machineColumns} FROM machine ORDER BY name`.pipe(Effect.orDie),

      machineNamed: (name: string) =>
        sql<MachineRow>`SELECT ${machineColumns} FROM machine WHERE name = ${name}`.pipe(
          Effect.map((rows) => rows[0]),
          Effect.orDie,
        ),

      machineWithVibestd: (id: string) =>
        sql<MachineRow>`SELECT ${machineColumns} FROM machine WHERE vibestd_id = ${id}`.pipe(
          Effect.map((rows) => rows[0]),
          Effect.orDie,
        ),

      addMachine: (row: { readonly name: string; readonly target: string; readonly vibestdId: string }) =>
        Effect.gen(function* () {
          const at = yield* now
          const [added] =
            yield* sql<MachineRow>`INSERT INTO machine ${sql.insert({ ...row, connectedAt: at, createdAt: at })}
            ON CONFLICT DO NOTHING RETURNING ${machineColumns}`
          return added
        }).pipe(Effect.orDie),

      removeMachine: (name: string) =>
        sql`DELETE FROM machine WHERE name = ${name} RETURNING name`.pipe(
          Effect.map((rows) => rows.length > 0),
          Effect.orDie,
        ),

      machineConnected: (name: string) =>
        Effect.gen(function* () {
          yield* sql`UPDATE machine SET connected_at = ${yield* now} WHERE name = ${name}`
        }).pipe(Effect.orDie),

      projectRemote: (projectId: string) =>
        sql<{ path: string; remote: string | null }>`SELECT path, remote_url AS remote FROM project_repository
          WHERE project_id = ${projectId} ORDER BY rowid`.pipe(Effect.orDie),

      receivePeerItem: (item: {
        readonly id: string
        readonly recipient: string
        readonly content: string
      }): Effect.Effect<"unknown" | "duplicate" | "queued"> =>
        tx(
          Effect.gen(function* () {
            const [route] = yield* sql<{ project: string; recipient: string | null; entry: string | null }>`SELECT
                s.project_id AS project, p.entry_session_id AS entry,
                CASE WHEN s.ended_at IS NULL THEN s.id ELSE p.entry_session_id END AS recipient
              FROM session s JOIN project p ON p.id = s.project_id WHERE s.id = ${item.recipient}`
            if (route === undefined) return "unknown" as const
            const key = `peer:${item.id}`
            const recipient = route.recipient
            for (const at of new Set([item.recipient, recipient ?? item.recipient]))
              if ((yield* queuedBy(at, key)) !== undefined) return "duplicate" as const
            const here = recipient !== null && (recipient !== route.entry || (yield* present(route.project, recipient)))
            yield* insertInbox({
              recipient: recipient ?? item.recipient,
              kind: "notice",
              sender: null,
              content: item.content,
              status: here ? "pending" : "dropped",
              request: key,
            })
            return "queued" as const
          }),
        ).pipe(Effect.orDie),

      remoteProjects: sql<{ id: string; directory: string | null; repositories: number; remote: string }>`SELECT
            p.id, p.directory, r.remote_url AS remote,
            (SELECT count(*) FROM project_repository c WHERE c.project_id = p.id) AS repositories
          FROM project p JOIN project_repository r ON r.project_id = p.id
          WHERE r.remote_url IS NOT NULL ORDER BY p.rowid, r.rowid`.pipe(Effect.orDie),

      outboxOf: (peer: string) =>
        sql<Omit<OutboxRow, "reportTo"> & { readonly start: string | null }>`SELECT o.id, o.session_id, o.kind,
            o.content, o.created_at,
            (SELECT pe.data FROM event pe WHERE pe.session_id = o.session_id AND pe.type = 'peer.start' LIMIT 1) AS start
          FROM outbox o WHERE o.peer_id = ${peer} ORDER BY o.created_at, o.rowid`.pipe(
          Effect.flatMap((rows) =>
            Effect.forEach(rows, ({ start, ...row }) =>
              Effect.map(peerStartOf(row.sessionId, start), (origin): Array<OutboxRow> =>
                origin?.reportTo === undefined ? [] : [{ ...row, reportTo: origin.reportTo }],
              ),
            ),
          ),
          Effect.map((rows) => rows.flat()),
          Effect.orDie,
        ),

      ackOutbox: (peer: string, ids: ReadonlyArray<string>) =>
        (ids.length === 0
          ? Effect.void
          : sql`DELETE FROM outbox WHERE peer_id = ${peer} AND ${sql.in("id", ids)}`.pipe(Effect.asVoid)
        ).pipe(Effect.orDie),

      notePeer: (peer: { readonly id: string; readonly name: string; readonly callsMe: string }) =>
        Effect.gen(function* () {
          const at = yield* now
          yield* sql`INSERT INTO peer ${sql.insert({ id: peer.id, name: peer.name, callsMe: peer.callsMe, connectedAt: at })}
            ON CONFLICT (id) DO UPDATE SET name = excluded.name, calls_me = excluded.calls_me,
              connected_at = excluded.connected_at`
        }).pipe(Effect.orDie),

      peerKnown: (id: string) =>
        sql`SELECT 1 FROM peer WHERE id = ${id}`.pipe(
          Effect.map((rows) => rows.length > 0),
          Effect.orDie,
        ),
    },
  }
}
