import type { Fact, FactOf, FactType } from "@vibest/schema/event"
import { Effect } from "effect"
import type { SqlClient, SqlError } from "effect/sql"

export const PROJECTION_VERSION = 4

export const PROJECTION_SCHEMA = [
  `CREATE INDEX event_session ON event (session_id, seq) WHERE session_id IS NOT NULL`,
  `CREATE TABLE project (
    id               TEXT PRIMARY KEY CHECK (length(id) = 36),
    directory        TEXT UNIQUE,
    entry_session_id TEXT
  ) STRICT`,
  `CREATE TABLE project_repository (
    project_id TEXT NOT NULL,
    path       TEXT NOT NULL UNIQUE,
    remote_url TEXT
  ) STRICT`,
  `CREATE INDEX project_repository_project ON project_repository (project_id)`,
  `CREATE TABLE session (
    id                    TEXT PRIMARY KEY,
    project_id            TEXT NOT NULL,
    parent_session_id     TEXT,
    role                  TEXT NOT NULL,
    name                  TEXT NOT NULL,
    directory             TEXT NOT NULL,
    archive_on_idle       INTEGER NOT NULL DEFAULT 0 CHECK (archive_on_idle IN (0, 1)),
    origin_peer           TEXT,
    origin_project        TEXT,
    origin_session        TEXT,
    created_at            INTEGER NOT NULL,
    ended_at              INTEGER,
    process_id            INTEGER,
    turn_id               INTEGER,
    active_at             INTEGER
  ) STRICT`,
  `CREATE INDEX session_project ON session (project_id)`,
  `CREATE INDEX session_parent ON session (parent_session_id)`,
  `CREATE INDEX session_live ON session (directory) WHERE ended_at IS NULL`,
  `CREATE INDEX session_origin ON session (origin_peer, origin_project) WHERE origin_peer IS NOT NULL`,
  `CREATE TABLE process (
    id                   INTEGER PRIMARY KEY,
    session_id           TEXT NOT NULL,
    harness              TEXT NOT NULL,
    provider             TEXT,
    model                TEXT,
    routing              TEXT,
    runtime              TEXT NOT NULL,
    terminal             TEXT,
    pid                  INTEGER,
    integration_version  TEXT,
    integration_protocol INTEGER,
    conversation         TEXT,
    started_at           INTEGER NOT NULL,
    placed_at            INTEGER,
    ready_at             INTEGER,
    ready_seq            INTEGER,
    ended_at             INTEGER,
    end_reason           TEXT
  ) STRICT`,
  `CREATE UNIQUE INDEX process_live ON process (session_id) WHERE ended_at IS NULL`,
  `CREATE INDEX process_session ON process (session_id, id)`,
  `CREATE INDEX process_terminal ON process (runtime, terminal) WHERE ended_at IS NULL AND terminal IS NOT NULL`,
  `CREATE TABLE turn (
    id         INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL,
    process_id INTEGER,
    typed      TEXT,
    started_at INTEGER NOT NULL,
    status     TEXT CHECK (status IN ('completed', 'failed', 'interrupted', 'lost', 'not_started')),
    report_seq INTEGER,
    failure    TEXT,
    answer     TEXT,
    ended_at   INTEGER
  ) STRICT`,
  `CREATE UNIQUE INDEX turn_open ON turn (session_id) WHERE status IS NULL`,
  `CREATE INDEX turn_session ON turn (session_id, id)`,
  `CREATE INDEX turn_report ON turn (report_seq) WHERE report_seq IS NOT NULL`,
  `CREATE TABLE inbox (
    id                   INTEGER PRIMARY KEY,
    recipient_session_id TEXT,
    sender_session_id    TEXT,
    kind                 TEXT NOT NULL CHECK (kind IN ('task', 'send', 'report', 'result', 'notice')),
    content              TEXT NOT NULL,
    request              TEXT,
    peer_item            TEXT,
    status               TEXT NOT NULL CHECK (status IN ('pending', 'delivering', 'delivered', 'failed', 'dropped')),
    turn_id              INTEGER,
    seq                  INTEGER NOT NULL,
    CHECK (recipient_session_id IS NOT NULL OR sender_session_id IS NOT NULL)
  ) STRICT`,
  `CREATE INDEX inbox_status ON inbox (status, recipient_session_id)`,
  `CREATE INDEX inbox_recipient ON inbox (recipient_session_id, kind, id)`,
  `CREATE INDEX inbox_turn ON inbox (turn_id) WHERE turn_id IS NOT NULL`,
  `CREATE INDEX inbox_request ON inbox (request) WHERE request IS NOT NULL`,
  `CREATE UNIQUE INDEX inbox_peer_item ON inbox (peer_item) WHERE peer_item IS NOT NULL`,
  `CREATE TABLE machine (
    name         TEXT PRIMARY KEY,
    target       TEXT NOT NULL,
    vibestd_id   TEXT NOT NULL UNIQUE CHECK (length(vibestd_id) = 36),
    connected_at INTEGER NOT NULL,
    created_at   INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE peer (
    id           TEXT PRIMARY KEY CHECK (length(id) = 36),
    name         TEXT NOT NULL,
    calls_me     TEXT NOT NULL,
    connected_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE outbox (
    id         TEXT PRIMARY KEY CHECK (length(id) = 36),
    seq        INTEGER NOT NULL,
    peer_id    TEXT NOT NULL,
    session_id TEXT NOT NULL,
    kind       TEXT NOT NULL CHECK (kind IN ('result', 'notice')),
    content    TEXT NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE INDEX outbox_peer ON outbox (peer_id, seq)`,
  `CREATE INDEX outbox_session ON outbox (session_id)`,
]

export const PROJECTION_TABLES = {
  project: "id",
  project_repository: "path",
  session: "id",
  process: "id",
  turn: "id",
  inbox: "id",
  machine: "name",
  peer: "id",
  outbox: "id",
} as const

type Projector<T extends FactType> = (
  fact: FactOf<T>,
  sql: SqlClient.SqlClient,
) => Effect.Effect<unknown, SqlError.SqlError>

type Repositories = FactOf<"project.created">["data"]["repositories"]

const putRepositories = (sql: SqlClient.SqlClient, projectId: string, repositories: Repositories) =>
  Effect.forEach(
    repositories,
    (r) => sql`INSERT INTO project_repository (project_id, path, remote_url) VALUES (${projectId}, ${r.path},
        ${r.remote ?? null})
      ON CONFLICT (path) DO UPDATE SET remote_url = excluded.remote_url WHERE project_id = excluded.project_id`,
    { discard: true },
  )

const projectIdOf = (fact: Fact) => fact.projectId!
const sessionIdOf = (fact: Fact) => fact.sessionId!

export const projectors: { readonly [T in FactType]: Projector<T> } = {
  "project.created": (fact, sql) =>
    Effect.andThen(
      sql`INSERT INTO project (id, directory) VALUES (${projectIdOf(fact)}, ${fact.data.directory ?? null})`,
      putRepositories(sql, projectIdOf(fact), fact.data.repositories),
    ),
  "project.moved": (fact, sql) =>
    Effect.gen(function* () {
      const id = projectIdOf(fact)
      const { from, to } = fact.data
      yield* sql`UPDATE project SET directory = ${to} WHERE id = ${id}`
      yield* sql`DELETE FROM project_repository WHERE project_id = ${id}`
      yield* putRepositories(sql, id, fact.data.repositories)
      yield* sql`UPDATE session SET directory = ${to} || substr(directory, ${from.length + 1})
        WHERE project_id = ${id} AND (directory = ${from} OR substr(directory, 1, ${from.length + 1}) = ${`${from}/`})`
    }),
  "project.repositories_changed": (fact, sql) => putRepositories(sql, projectIdOf(fact), fact.data.repositories),
  "project.entry_changed": (fact, sql) =>
    sql`UPDATE project SET entry_session_id = ${fact.data.session ?? null} WHERE id = ${projectIdOf(fact)}`,

  "session.created": (fact, sql) => {
    const { data } = fact
    const origin = data.origin
    return sql`INSERT INTO session (id, project_id, parent_session_id, role, name, directory, archive_on_idle,
        origin_peer, origin_project, origin_session, created_at, active_at)
      VALUES (${sessionIdOf(fact)}, ${projectIdOf(fact)}, ${data.parent ?? null}, ${data.role}, ${data.name},
        ${data.directory}, ${data.archiveOnCompletion ? 1 : 0}, ${origin?.peer ?? null}, ${origin?.project ?? null},
        ${origin?.reportTo ?? null}, ${fact.at}, ${origin === undefined ? null : fact.at})`
  },
  "session.renamed": (fact, sql) => sql`UPDATE session SET name = ${fact.data.name} WHERE id = ${sessionIdOf(fact)}`,
  "session.directory_changed": (fact, sql) =>
    sql`UPDATE session SET directory = ${fact.data.directory} WHERE id = ${sessionIdOf(fact)}`,
  "session.ended": (fact, sql) =>
    Effect.andThen(
      sql`UPDATE session SET ended_at = coalesce(ended_at, ${fact.at}) WHERE id = ${sessionIdOf(fact)}`,
      sql`DELETE FROM outbox WHERE session_id = ${sessionIdOf(fact)}`,
    ),

  "process.started": (fact, sql) => {
    const { data } = fact
    return Effect.andThen(
      sql`INSERT INTO process (id, session_id, harness, provider, model, routing, conversation, runtime, terminal,
          pid, started_at, placed_at)
        VALUES (${fact.seq}, ${sessionIdOf(fact)}, ${data.harness}, ${data.provider ?? null}, ${data.model ?? null},
          ${data.routing === undefined ? null : JSON.stringify(data.routing)}, ${data.resume ?? null}, ${data.runtime},
          ${data.terminal ?? null}, ${data.pid ?? null}, ${fact.at}, ${data.terminal === undefined ? null : fact.at})`,
      sql`UPDATE session SET process_id = ${fact.seq} WHERE id = ${sessionIdOf(fact)}`,
    )
  },
  "process.placed": (fact, sql) =>
    sql`UPDATE process SET terminal = ${fact.data.terminal}, placed_at = ${fact.at},
        pid = coalesce(${fact.data.pid ?? null}, pid)
      WHERE id = ${fact.data.process}`,
  "process.ready": (fact, sql) => {
    const { integration } = fact.data
    return sql`UPDATE process SET ready_at = ${fact.at}, ready_seq = coalesce(ready_seq, ${fact.seq}),
        pid = coalesce(${fact.data.pid ?? null}, pid),
        integration_version = ${integration === undefined ? sql`integration_version` : integration.version},
        integration_protocol = ${integration === undefined ? sql`integration_protocol` : integration.protocol}
      WHERE id = ${fact.data.process}`
  },
  "process.pid": (fact, sql) => sql`UPDATE process SET pid = ${fact.data.pid} WHERE id = ${fact.data.process}`,
  "process.conversation": (fact, sql) =>
    sql`UPDATE process SET conversation = ${fact.data.conversation} WHERE id = ${fact.data.process}`,
  "process.ended": (fact, sql) =>
    Effect.gen(function* () {
      const { process, reason } = fact.data
      yield* sql`UPDATE process SET ended_at = ${fact.at}, end_reason = ${reason}
        WHERE id = ${process} AND ended_at IS NULL`
      if (reason !== "launch_failed") return
      const session = sessionIdOf(fact)
      yield* sql`UPDATE session SET process_id = coalesce((SELECT max(id) FROM process WHERE session_id = ${session}
          AND NOT (terminal IS NULL AND end_reason = 'launch_failed')), process_id)
        WHERE id = ${session} AND EXISTS (SELECT 1 FROM process WHERE id = ${process} AND terminal IS NULL)`
    }),

  "turn.started": (fact, sql) =>
    Effect.andThen(
      sql`INSERT INTO turn (id, session_id, process_id, typed, started_at)
        VALUES (${fact.seq}, ${sessionIdOf(fact)}, ${fact.data.process ?? null}, ${fact.data.typed ?? null},
          ${fact.at})`,
      sql`UPDATE session SET turn_id = ${fact.seq} WHERE id = ${sessionIdOf(fact)}`,
    ),
  "turn.reported": () => Effect.void,
  "turn.ended": (fact, sql) =>
    Effect.andThen(
      sql`UPDATE turn SET status = ${fact.data.status}, report_seq = ${fact.data.report ?? null},
          answer = coalesce(${fact.data.reply ?? null},
            (SELECT data ->> '$.text' FROM event WHERE seq = ${fact.data.report ?? null} AND type = 'turn.reported')),
          failure = ${fact.data.failure?.message ?? null}, ended_at = ${fact.at}
        WHERE id = ${fact.data.turn} AND status IS NULL`,
      fact.data.conversation === undefined
        ? Effect.void
        : sql`UPDATE process SET conversation = ${fact.data.conversation}
            WHERE id = (SELECT process_id FROM session WHERE id = ${sessionIdOf(fact)})`,
    ),

  "inbox.queued": (fact, sql) => {
    const { data } = fact
    return sql`INSERT INTO inbox (id, recipient_session_id, sender_session_id, kind, content, request, peer_item, status, seq)
      VALUES (${fact.seq}, ${data.recipient ?? null}, ${data.sender ?? null}, ${data.kind}, ${data.content},
        ${data.request ?? null}, ${data.peerItem ?? null}, ${data.status}, ${fact.seq})`
  },
  "inbox.moved": (fact, sql) =>
    sql`UPDATE inbox SET status = ${fact.data.to}, seq = ${fact.seq},
        turn_id = coalesce(${fact.data.turn ?? null}, turn_id)
      WHERE id = ${fact.data.inbox}`,

  "machine.added": (fact, sql) =>
    sql`INSERT INTO machine (name, target, vibestd_id, connected_at, created_at)
      VALUES (${fact.data.name}, ${fact.data.target}, ${fact.data.vibestd}, ${fact.at}, ${fact.at})`,
  "machine.connected": (fact, sql) => sql`UPDATE machine SET connected_at = ${fact.at} WHERE name = ${fact.data.name}`,
  "machine.removed": (fact, sql) => sql`DELETE FROM machine WHERE name = ${fact.data.name}`,

  "peer.seen": (fact, sql) =>
    sql`INSERT INTO peer (id, name, calls_me, connected_at)
      VALUES (${fact.data.id}, ${fact.data.name}, ${fact.data.callsMe}, ${fact.at})
      ON CONFLICT (id) DO UPDATE SET name = excluded.name, calls_me = excluded.calls_me,
        connected_at = excluded.connected_at`,

  "outbox.queued": (fact, sql) =>
    sql`INSERT INTO outbox (id, seq, peer_id, session_id, kind, content, created_at)
      VALUES (${fact.data.id}, ${fact.seq}, ${fact.data.peer}, ${sessionIdOf(fact)}, ${fact.data.kind},
        ${fact.data.content}, ${fact.at})`,
  "outbox.acked": (fact, sql) =>
    sql`DELETE FROM outbox WHERE peer_id = ${fact.data.peer} AND ${sql.in("id", fact.data.ids)}`,
}

const touchesActivity = (type: FactType) =>
  type.startsWith("process.") || type.startsWith("turn.") || type.startsWith("inbox.")

export const project = (fact: Fact, sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    yield* (projectors[fact.type] as Projector<FactType>)(fact as never, sql)
    if (fact.sessionId !== undefined && touchesActivity(fact.type))
      yield* sql`UPDATE session SET active_at = max(coalesce(active_at, 0), ${fact.at}) WHERE id = ${fact.sessionId}`
  })
