import { newId } from "@vibest/schema/id"
import { MessageStatus } from "@vibest/schema/model"
import {
  AgentStatus,
  AmbiguousSession,
  InboxKind,
  InboxRow,
  InboxStatus,
  NoSuchSession,
  RuntimeAddress,
  TurnState,
} from "@vibest/schema/session"
// The only place with SQL (docs/design/schema.md, version 1: project, project_repository, session, inbox, event). One
// schema, no migrations: an empty database gets it in one transaction; any other file is accepted only when its
// version pragmas and required objects already match. A file of the shape from before this baseline (it also says
// version 1, but has no event table) is refused, naming the one-time migration script given with the release.
// `inspectSchema` only reads; the driver must run it on a read-only connection before opening an existing file
// writable. One SQLite connection through effect/sql (the driver comes from #platform); rows are decoded with Schema;
// multi-row changes run in `tx`: one transaction, and the events it appended are published after the commit.
//
// The session row callers read (`SessionRow`) is a read model: its process, turn and live fields come from the
// append-only `event` table, and every change to them appends an event (schema.md, Event types).
import { Clock, Context, Effect, Layer, Schema, String as Str } from "effect"
import { SqlClient, type Statement } from "effect/sql"

import { Bus, type StoredEvent, type StoredType } from "./bus.ts"
import { HARNESS_IDS, type HarnessId } from "./harness.ts"
import { Routing } from "./plugins.ts"
import type { TurnEnded } from "./results.ts"
export { RuntimeAddress, InboxKind, InboxRow, InboxStatus, AgentStatus, TurnState } from "@vibest/schema/session"

export const AddressJson = Schema.fromJsonString(RuntimeAddress)
export const encodeAddress = Schema.encodeSync(AddressJson)

/** What a running agent reports and a restart needs; on every session row, the main agent's too. */
const Live = {
  /** The integration (harness plugin) version and protocol the agent last sent (vibest-plugin-version, vibest-protocol). */
  integration: Schema.optional(Schema.Struct({ version: Schema.String, protocol: Schema.Number })),
  /** The harness's own process, as its integration reported it when ready: the pid a restart sends SIGTERM to. */
  pid: Schema.optional(Schema.Number),
  /** When the harness's integration reported it takes input; none since its process started. */
  ready: Schema.optional(Schema.Number),
}

const Metadata = Schema.Struct({
  ...Live,
  routing: Schema.optional(Routing),
  /** `vibest run --archive-on-completion`: archived once a completed result reached the coordinator. */
  archive: Schema.optional(Schema.Boolean),
  /** `vibest archive` (alias `rm`) ran (`session.ended_at`): never resumed again, even when its worktree was kept. */
  archived: Schema.optional(Schema.Boolean),
  /** Same as `archived`, for older readers. */
  removed: Schema.optional(Schema.Boolean),
  /**
   * Real usage-limit tries for this session, oldest first: the (harness, provider) pairs whose process ended on a
   * limit (`process.end` reason `limited`). Skips inside one move are not kept.
   */
  attempts: Schema.optional(
    Schema.Array(
      Schema.Struct({
        harness: Schema.String,
        provider: Schema.optional(Schema.String),
        outcome: Schema.Literal("limited"),
        at: Schema.Number,
      }),
    ),
  ),
})
/** A session in the shape its callers read: its columns plus what its events say. */
export const SessionRow = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  agent: Schema.String,
  harnessId: Schema.Literals(HARNESS_IDS),
  harnessSessionId: Schema.NullOr(Schema.String),
  runtime: Schema.String,
  address: AddressJson,
  name: Schema.String,
  provider: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
  /** The runtime's status of the agent, last seen; `unknown` before the runtime reported it. Memory only. */
  status: AgentStatus,
  /** When its agent last started (spawn or resume); null while the first start is under way. */
  startedAt: Schema.NullOr(Schema.Number),
  /** When its agent process was seen gone (or never came up); cleared when it starts again. */
  exitedAt: Schema.NullOr(Schema.Number),
  turnState: TurnState,
  turnPromptedAt: Schema.Number,
  metadata: Schema.fromJsonString(Metadata),
  createdAt: Schema.Number,
  lastActive: Schema.Number,
})
export type SessionRow = typeof SessionRow.Type

/** Why a process ended (`process.end` reason). */
export type EndReason = "exited" | "limited" | "restart" | "move" | "archived" | "launch_failed"

export type SessionPatch = Partial<Omit<SessionRow, "id" | "projectId" | "agent" | "createdAt" | "runtime">> & {
  /** With `exitedAt`: why its process ended. Default `exited`. */
  readonly end?: EndReason
}

/** The project's main agent. */
export const CoordinatorRow = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  harnessId: Schema.Literals(HARNESS_IDS),
  harnessSessionId: Schema.NullOr(Schema.String),
  runtime: Schema.NullOr(Schema.String),
  address: Schema.NullOr(AddressJson),
  /** The project directory (`project.directory`), else its main session's. Absent when neither is known. */
  projectDirectory: Schema.optional(Schema.String),
  createdAt: Schema.Number,
  /** What scheduling chose when it last started (Project.StartMain): provider, model, routing. */
  provider: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
  routing: Schema.optional(Routing),
  ...Live,
})
export type CoordinatorRow = typeof CoordinatorRow.Type

export type NewInboxRow = Omit<InboxRow, "id" | "status" | "createdAt">

/** A repository of a project as `project_repository` keeps it: its main checkout's realpath and raw origin. */
export type RepositoryRow = { readonly path: string; readonly remote: string | undefined }

/** "vibe", as a 32-bit application id. */
export const APPLICATION_ID = 0x76696265
export const SCHEMA_VERSION = 1

export const SCHEMA = [
  `PRAGMA application_id = ${APPLICATION_ID}`,
  `PRAGMA user_version = ${SCHEMA_VERSION}`,
  `CREATE TABLE project (
    id               TEXT PRIMARY KEY CHECK (length(id) = 36),
    directory        TEXT UNIQUE,
    entry_session_id TEXT REFERENCES session (id)
  ) STRICT`,
  `CREATE TABLE project_repository (
    project_id TEXT NOT NULL REFERENCES project (id),
    path       TEXT NOT NULL UNIQUE,
    remote_url TEXT
  ) STRICT`,
  `CREATE INDEX project_repository_project ON project_repository (project_id)`,
  `CREATE TABLE session (
    id                    TEXT PRIMARY KEY,
    project_id            TEXT NOT NULL REFERENCES project (id),
    parent_session_id     TEXT REFERENCES session (id),
    report_to_session_id  TEXT REFERENCES session (id),
    role                  TEXT NOT NULL,
    name                  TEXT NOT NULL,
    machine               TEXT NOT NULL,
    directory             TEXT NOT NULL,
    archive_on_completion INTEGER NOT NULL DEFAULT 0 CHECK (archive_on_completion IN (0, 1)),
    created_at            INTEGER NOT NULL,
    ended_at              INTEGER
  ) STRICT`,
  `CREATE INDEX session_project ON session (project_id)`,
  `CREATE INDEX session_parent ON session (parent_session_id)`,
  `CREATE INDEX session_live ON session (machine, directory) WHERE ended_at IS NULL`,
  `CREATE TABLE inbox (
    id                   INTEGER PRIMARY KEY,
    recipient_session_id TEXT REFERENCES session (id),
    kind                 TEXT NOT NULL CHECK (kind IN ('task', 'send', 'report', 'result', 'notice')),
    sender_session_id    TEXT REFERENCES session (id),
    content              TEXT NOT NULL,
    result_event_id      INTEGER REFERENCES event (id),
    status               TEXT NOT NULL CHECK (status IN ('pending', 'delivering', 'delivered', 'failed', 'dropped')),
    CHECK ((kind = 'result') = (result_event_id IS NOT NULL)),
    CHECK (recipient_session_id IS NOT NULL OR sender_session_id IS NOT NULL)
  ) STRICT`,
  `CREATE INDEX inbox_status ON inbox (status, recipient_session_id)`,
  `CREATE INDEX inbox_recipient ON inbox (recipient_session_id, kind, id)`,
  `CREATE INDEX inbox_result ON inbox (result_event_id) WHERE result_event_id IS NOT NULL`,
  `CREATE TABLE event (
    id         INTEGER PRIMARY KEY,
    at         INTEGER NOT NULL,
    session_id TEXT NOT NULL REFERENCES session (id),
    type       TEXT NOT NULL,
    process_id INTEGER REFERENCES event (id),
    turn_id    INTEGER REFERENCES event (id),
    inbox_id   INTEGER REFERENCES inbox (id),
    data       TEXT NOT NULL DEFAULT '{}'
  ) STRICT`,
  `CREATE INDEX event_session ON event (session_id, type, id)`,
  `CREATE INDEX event_process ON event (process_id, type, id) WHERE process_id IS NOT NULL`,
  `CREATE INDEX event_turn ON event (turn_id, type) WHERE turn_id IS NOT NULL`,
  `CREATE INDEX event_inbox ON event (inbox_id) WHERE inbox_id IS NOT NULL`,
  `CREATE UNIQUE INDEX event_process_end ON event (process_id) WHERE type = 'process.end'`,
  `CREATE UNIQUE INDEX event_turn_end ON event (turn_id) WHERE type = 'turn.end'`,
  `CREATE INDEX event_terminal ON event (json_extract(data, '$.runtime'), json_extract(data, '$.machine'),
    json_extract(data, '$.terminal')) WHERE type = 'process.start'`,
  `CREATE TRIGGER event_no_update BEFORE UPDATE ON event
    BEGIN SELECT RAISE(ABORT, 'event is append-only'); END`,
]

export class SchemaMismatch extends Schema.TaggedError<SchemaMismatch>()("SchemaMismatch", {
  version: Schema.Number,
  applicationId: Schema.Number,
  detail: Schema.optional(Schema.String),
  /** vibest's own file in the shape from before this baseline (no event table). */
  older: Schema.optional(Schema.Boolean),
  /** The database file, set by the driver that opened it. */
  file: Schema.optional(Schema.String),
}) {
  override get message() {
    const file = this.file ?? "vibest.db"
    if (this.older)
      return `${file} is from an older vibest (its tables are the shape from before this release); this vibest never migrates by itself. Stop vibestd, then migrate it once with the migration script given with this release (it backs the file up first), or move it aside to start empty`
    const id = `0x${(this.applicationId >>> 0).toString(16)}`
    const extra = this.detail === undefined ? "" : `, ${this.detail}`
    return `${file} is not this vibest's schema (application_id ${id}, v${this.version}${extra}); stop vibestd and move it aside to start empty`
  }
}

/** The objects an existing file must have. Columns are not diffed. */
const REQUIRED = SCHEMA.flatMap((statement) => {
  const found = /^CREATE (?:UNIQUE )?(TABLE|INDEX|TRIGGER) (\w+)/.exec(statement)
  return found ? [{ type: found[1]!.toLowerCase(), name: found[2]! }] : []
})

const mismatch = (version: number, applicationId: number, detail?: string) =>
  new SchemaMismatch({ version, applicationId, ...(detail === undefined ? {} : { detail }) })

/** Read-only. `"empty"` has no objects; `"ready"` is this schema. Does not install or repair. */
export const inspectSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql.unsafe<{ type: string; name: string }>("SELECT type, name FROM sqlite_master")
  if (rows.length === 0) return "empty" as const
  const applicationId = (yield* sql<{ applicationId: number }>`PRAGMA application_id`)[0]?.applicationId ?? 0
  const userVersion = (yield* sql<{ userVersion: number }>`PRAGMA user_version`)[0]?.userVersion ?? 0
  const missing = REQUIRED.find((object) => !rows.some((row) => row.type === object.type && row.name === object.name))
  // The shape before this baseline carries the same pragmas; it is told apart by its tables.
  if (
    applicationId === APPLICATION_ID &&
    userVersion === SCHEMA_VERSION &&
    !rows.some((row) => row.type === "table" && row.name === "event")
  )
    return yield* new SchemaMismatch({ version: userVersion, applicationId, older: true })
  if (applicationId !== APPLICATION_ID || userVersion !== SCHEMA_VERSION || missing !== undefined) {
    return yield* mismatch(
      userVersion,
      applicationId,
      missing === undefined || userVersion !== SCHEMA_VERSION ? undefined : `missing ${missing.name}`,
    )
  }
  return "ready" as const
})

const objectCount = SqlClient.SqlClient.pipe(
  Effect.flatMap((sql) => sql<{ n: number }>`SELECT count(*) AS n FROM sqlite_master`),
  Effect.map((rows) => rows[0]?.n ?? 0),
)

/** Install the schema on an empty file; refuse anything else that is not already this schema, without writing (SPEC §5.2). */
export const migrate = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  if ((yield* inspectSchema) === "empty") {
    // The write lock makes the recheck authoritative: a concurrent empty open either installs or sees the winner.
    const installed = yield* sql.withTransaction(
      Effect.gen(function* () {
        if ((yield* objectCount) !== 0) return false
        for (const statement of SCHEMA) yield* sql.unsafe(statement)
        return true
      }),
    )
    if (installed) return
  }
  if ((yield* inspectSchema) !== "ready") return yield* mismatch(0, 0, "empty after install")
})

/** `process.start` data (schema.md): the choice and where it runs. An empty terminal: chosen, its terminal not open yet. */
type ProcessStart = {
  readonly harness: string
  readonly provider?: string
  readonly model?: string
  readonly routing?: unknown
  readonly runtime: string
  readonly machine: string
  readonly terminal: string
  /** The conversation id it continues (or was given before its first start). */
  readonly resume?: string
  /** The harness's pid when vibest itself execs it (the main agent), before its integration reports one. */
  readonly pid?: number
}

type Integration = { readonly version: string; readonly protocol: number }

/** One session row with what its events say, as the read query returns it. */
type SessionSql = {
  readonly id: string
  readonly project: string
  readonly role: string
  readonly name: string
  readonly machine: string
  readonly archive: number
  readonly createdAt: number
  readonly endedAt: number | null
  readonly pId: number | null
  readonly pAt: number | null
  readonly pData: string | null
  readonly pEnded: number | null
  readonly pid: number | null
  readonly readyAt: number | null
  readonly integration: string | null
  readonly conversation: string | null
  readonly tId: number | null
  readonly tAt: number | null
  readonly tEnd: string | null
  readonly lastAt: number | null
  readonly attempts: string | null
}

/** A session's current process, as its latest `process.start` and what followed it say. */
type Current = {
  readonly id: number
  readonly start: ProcessStart
  readonly at: number
  readonly ended: number | null
}

const currentOf = (row: SessionSql): Current | undefined =>
  row.pId === null || row.pData === null || row.pAt === null
    ? undefined
    : { id: row.pId, start: JSON.parse(row.pData) as ProcessStart, at: row.pAt, ended: row.pEnded }

const attemptsOf = (raw: string | null) => {
  const seen: Array<{ harness: string; provider?: string; outcome: "limited"; at: number }> = []
  for (const a of JSON.parse(raw ?? "[]") as ReadonlyArray<{ harness: string; provider: string | null; at: number }>) {
    const provider = a.provider ?? undefined
    if (seen.some((s) => s.harness === a.harness && s.provider === provider)) continue
    seen.push({ harness: a.harness, ...(provider === undefined ? {} : { provider }), outcome: "limited", at: a.at })
  }
  return seen
}

const fromColumns = (row: SessionSql, status: AgentStatus, integration: Integration | undefined) => {
  const p = currentOf(row)
  const start = p?.start
  const ended = row.endedAt !== null
  const integrationNow =
    integration ?? (row.integration !== null ? (JSON.parse(row.integration) as Integration) : undefined)
  const pid = row.pid ?? start?.pid ?? null
  const attempts = attemptsOf(row.attempts)
  const metadata = {
    ...(integrationNow === undefined ? {} : { integration: integrationNow }),
    ...(pid === null ? {} : { pid }),
    ...(row.readyAt === null ? {} : { ready: row.readyAt }),
    ...(start?.routing === undefined ? {} : { routing: start.routing }),
    ...(row.archive === 1 ? { archive: true } : {}),
    ...(ended && row.role !== "main" ? { archived: true, removed: true } : {}),
    ...(attempts.length > 0 ? { attempts } : {}),
  }
  const started = p !== undefined && start!.terminal !== "" ? p.at : null
  return {
    id: row.id,
    projectId: row.project,
    agent: row.role,
    harnessId: start?.harness ?? "",
    harnessSessionId: row.conversation ?? start?.resume ?? null,
    runtime: start?.runtime ?? "",
    address: JSON.stringify({ machine: start?.machine ?? row.machine, id: start?.terminal ?? "" }),
    name: row.name,
    provider: start?.provider ?? null,
    model: start?.model ?? null,
    status,
    startedAt: started,
    exitedAt: row.role === "main" ? row.endedAt : (p?.ended ?? null),
    turnState:
      row.tId === null ? "none" : row.tEnd === null ? "open" : row.tEnd === "not_started" ? "not_started" : row.tEnd,
    turnPromptedAt: row.tAt ?? 0,
    metadata: JSON.stringify(metadata),
    createdAt: row.createdAt,
    lastActive: row.lastAt ?? row.createdAt,
  }
}
const decodeSessions = Schema.decodeUnknownEffect(Schema.Array(SessionRow))

/** Public `sending` is the column value `delivering`. */
const storedStatus = (status: InboxStatus) => (status === "sending" ? "delivering" : status)

type InboxSql = {
  readonly id: number
  readonly recipientSessionId: string | null
  readonly kind: string
  readonly senderSessionId: string | null
  readonly content: string
  readonly status: string
  readonly turnEnd: string | null
}

/** The text between `<summary>` and `</summary>` of a rendered result, unescaped; undefined without one. */
const summaryIn = (content: string) => {
  const found = /<summary>([\s\S]*?)<\/summary>/.exec(content)
  return found === null
    ? undefined
    : found[1]!.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&amp;", "&")
}

const ROUND_STATUS = ["completed", "failed", "interrupted", "lost", "not_started"] as const

/** `turn.end` data (schema.md), written once. */
export type TurnEnd = {
  readonly status: (typeof ROUND_STATUS)[number]
  /** The harness's last answer text. Rows written before `report`; new ends leave it out. */
  readonly output?: string
  /** The `turn.reported` event this end consumed. */
  readonly report?: number
  /** The harness's error. */
  readonly failure?: { readonly message: string }
}

/** A `turn.reported` row: the harness's turn end as received, and its event id. */
export type TurnReport = TurnEnded & { readonly id: number }

/** A harness error as `turn.end` failure; none for an empty error. */
export const failureOf = (error: string | undefined): TurnEnd["failure"] =>
  error === undefined || error === "" ? undefined : { message: error }

/** What a result row says, from the `turn.end` it reports and its rendered text. */
const resultDetails = (content: string, end: TurnEnd | undefined) => {
  const error = end?.failure?.message
  const summary = summaryIn(content)
  return {
    status: end?.status === "completed" && error === undefined ? "completed" : "failed",
    ...(summary === undefined ? {} : { summary }),
    ...(error === undefined ? {} : { error }),
  }
}

const toInbox = (row: InboxSql) => {
  const kind = row.kind as InboxKind
  const sessionId = kind === "send" ? row.recipientSessionId! : (row.senderSessionId ?? row.recipientSessionId ?? "")
  return {
    id: row.id,
    sessionId,
    kind,
    message: row.content,
    details:
      kind === "result"
        ? JSON.stringify(
            resultDetails(row.content, row.turnEnd === null ? undefined : (JSON.parse(row.turnEnd) as TurnEnd)),
          )
        : "{}",
    status: row.status === "delivering" ? "sending" : row.status,
    createdAt: 0,
  }
}

const MESSAGE_STATUSES: ReadonlySet<string> = new Set(MessageStatus.literals)
type MessageStatusName = typeof MessageStatus.Type

export type SessionBrief = {
  readonly task: string | null
  readonly latest: {
    readonly status: MessageStatusName
    readonly summary: string
    readonly endedAt: number | null
  } | null
}

type BriefRow = {
  readonly id: string
  readonly task: string | null
  readonly turnId: number | null
  readonly endData: string | null
  readonly endedAt: number | null
  readonly resultContent: string | null
  /** Answer text: the consumed `turn.reported`, else an old `turn.end`'s `output`. */
  readonly answer: string | null
}

const roundStatus = (status: unknown): TurnEnd["status"] =>
  typeof status === "string" && (ROUND_STATUS as readonly string[]).includes(status)
    ? (status as TurnEnd["status"])
    : "completed"

/** Rows a session's own sends and tasks are: never main-agent-bound. */
const TO_SESSION = `('task', 'send')`

/**
 * Rows appended by the fiber that opened the transaction. `closed` once that transaction ends: a forked fiber inherits
 * this reference (and the sql transaction) and must not append into a buffer nobody publishes.
 */
const TxBuffer = Context.Reference<
  { readonly events: Array<StoredEvent>; readonly fiberId: number; closed: boolean } | undefined
>("vibest/TxBuffer", { defaultValue: () => undefined })

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const bus = yield* Bus
  /**
   * The `process.start` that is the session's current process: its latest, passing over a start that never got its
   * terminal (`launch_failed`) when an earlier one exists, so a failed move leaves the harness that last ran.
   */
  const currentStart = (session: Statement.Fragment) => sql`(SELECT cs.id FROM event cs
      WHERE cs.session_id = ${session} AND cs.type = 'process.start'
      ORDER BY (json_extract(cs.data, '$.terminal') = '' AND EXISTS (SELECT 1 FROM event cf WHERE cf.process_id = cs.id
        AND cf.type = 'process.end' AND json_extract(cf.data, '$.reason') = 'launch_failed')), cs.id DESC LIMIT 1)`
  const now = Clock.currentTimeMillis
  const decodeInbox = Schema.decodeUnknownEffect(Schema.Array(InboxRow))
  const decodeCoordinators = Schema.decodeUnknownEffect(Schema.Array(CoordinatorRow))
  /** The runtime's last reported status per Agent: live, never stored (schema.md). */
  const statuses = new Map<string, AgentStatus>()
  /** The integration a session's requests last carried, until its next `process.ready` records it. */
  const integrations = new Map<string, Integration>()
  /**
   * When an open turn's text was last handed over (`turnPromptedAt` on an open turn: after a resume, or a move to the
   * next harness), by turn id. Memory only: without it the turn's own start time stands.
   */
  const prompted = new Map<number, number>()
  /** Projects whose main agent left its place to move to another terminal (`detachCoordinator`): memory only. */
  const moving = new Set<string>()
  /** No entry for `unknown` (what a missing one reads as) or an archived session (never live again): the map does not grow with ended sessions. */
  const remember = (row: Pick<SessionRow, "id" | "status" | "metadata">) => {
    if (row.metadata.archived || row.metadata.removed) integrations.delete(row.id)
    if (row.status === "unknown" || row.metadata.archived || row.metadata.removed) statuses.delete(row.id)
    else statuses.set(row.id, row.status)
  }

  const append = (event: {
    readonly sessionId: string
    readonly type: StoredType
    readonly processId?: number | undefined
    readonly turnId?: number | undefined
    readonly inboxId?: number | undefined
    readonly data?: Readonly<Record<string, unknown>>
    readonly at?: number
  }) =>
    Effect.gen(function* () {
      const buffer = yield* TxBuffer
      if (buffer === undefined) return yield* Effect.die(new Error("append outside a transaction"))
      if (buffer.closed || (yield* Effect.fiberId) !== buffer.fiberId)
        return yield* Effect.die(new Error("append not from the transaction fiber"))
      const at = event.at ?? (yield* now)
      const data = JSON.parse(JSON.stringify(event.data ?? {})) as Readonly<Record<string, unknown>>
      const [row] = yield* sql<{ id: number }>`INSERT INTO event ${sql.insert({
        at,
        sessionId: event.sessionId,
        type: event.type,
        ...(event.processId === undefined ? {} : { processId: event.processId }),
        ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
        ...(event.inboxId === undefined ? {} : { inboxId: event.inboxId }),
        data: JSON.stringify(data),
      })} RETURNING id`
      const id = row!.id
      const stored: StoredEvent = {
        id,
        at,
        sessionId: event.sessionId,
        type: event.type,
        data,
        ...(event.processId === undefined ? {} : { processId: event.processId }),
        ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
        ...(event.inboxId === undefined ? {} : { inboxId: event.inboxId }),
      }
      buffer.events.push(stored)
      return id
    })

  /**
   * Run `body` in one transaction. After it commits, publish the rows it appended, in id order. A nested call shares
   * this buffer, so only the outermost commit publishes. A rollback publishes nothing. Only `body` is interruptible:
   * an interrupt that comes once it has finished waits until the commit's rows are published, so none is dropped.
   */
  const tx = <A, E, R>(body: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      if ((yield* TxBuffer) !== undefined) return yield* body
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const buffer = { events: [] as Array<StoredEvent>, fiberId: yield* Effect.fiberId, closed: false }
          const result = yield* sql
            .withTransaction(restore(Effect.provideService(body, TxBuffer, buffer)))
            .pipe(Effect.ensuring(Effect.sync(() => (buffer.closed = true))))
          yield* bus.published(buffer.events)
          return result
        }),
      )
    })

  /** Some project id already starts with `short`. */
  const projectPrefixTaken = (short: string) =>
    sql`SELECT 1 FROM project WHERE id >= ${short} AND id < ${`${short}~`} LIMIT 1`.pipe(
      Effect.map((rows) => rows.length > 0),
    )
  /** Each repository row of project `id`; a path another project has is left to it. Its origin as git prints it now. */
  const putRepositories = (id: string, repositories: ReadonlyArray<RepositoryRow>) =>
    Effect.forEach(
      repositories,
      (
        r,
      ) => sql`INSERT INTO project_repository ${sql.insert({ projectId: id, path: r.path, remoteUrl: r.remote ?? null })}
        ON CONFLICT (path) DO UPDATE SET remote_url = excluded.remote_url WHERE project_id = excluded.project_id`,
      { discard: true },
    )

  const SESSION_COLUMNS = sql`a.id, a.project_id AS project, a.role, a.name, a.machine,
      a.archive_on_completion AS archive, a.created_at, a.ended_at,
      p.id AS p_id, p.at AS p_at, p.data AS p_data,
      (SELECT e.at FROM event e WHERE e.process_id = p.id AND e.type = 'process.end') AS p_ended,
      (SELECT json_extract(e.data, '$.pid') FROM event e WHERE e.process_id = p.id AND e.type = 'process.ready'
        AND json_extract(e.data, '$.pid') IS NOT NULL ORDER BY e.id DESC LIMIT 1) AS pid,
      (SELECT e.at FROM event e WHERE e.process_id = p.id AND e.type = 'process.ready'
        AND json_extract(e.data, '$.pidOnly') IS NULL ORDER BY e.id DESC LIMIT 1) AS ready_at,
      (SELECT json_extract(e.data, '$.integration') FROM event e WHERE e.process_id = p.id AND e.type = 'process.ready'
        AND json_extract(e.data, '$.integration') IS NOT NULL ORDER BY e.id DESC LIMIT 1) AS integration,
      (SELECT json_extract(e.data, '$.conversation') FROM event e WHERE e.process_id = p.id
        AND e.type IN ('process.ready', 'process.conversation') AND json_extract(e.data, '$.conversation') IS NOT NULL
        ORDER BY e.id DESC LIMIT 1) AS conversation,
      t.id AS t_id, t.at AS t_at,
      (SELECT json_extract(e.data, '$.status') FROM event e WHERE e.turn_id = t.id AND e.type = 'turn.end') AS t_end,
      (SELECT max(e.at) FROM event e WHERE e.session_id = a.id) AS last_at,
      (SELECT json_group_array(json_object('harness', json_extract(ps.data, '$.harness'),
          'provider', json_extract(ps.data, '$.provider'), 'at', pe.at))
        FROM (SELECT * FROM event WHERE session_id = a.id AND type = 'process.end'
          AND json_extract(data, '$.reason') = 'limited' ORDER BY id) pe
        JOIN event ps ON ps.id = pe.process_id) AS attempts
    FROM session a
    LEFT JOIN event p ON p.id = ${currentStart(sql`a.id`)}
    LEFT JOIN event t ON t.id = (SELECT max(id) FROM event WHERE session_id = a.id AND type = 'turn.start')`

  /** Subagents: not a main agent session, the current conversation or an earlier one (`vibest --new`). */
  const notMain = sql`a.role != 'main'`
  /** A main conversation `vibest --new` replaced. The current main agent stays a coordinator, not a session row. */
  const endedMain = sql`a.role = 'main' AND NOT EXISTS (SELECT 1 FROM project q WHERE q.entry_session_id = a.id)`
  /** Its latest process has not ended (or it has none yet). */
  const running = sql`p_ended IS NULL`
  const selectRaw = (where: ReadonlyArray<Statement.Fragment>, filter?: Statement.Fragment) =>
    sql<SessionSql>`SELECT * FROM (SELECT ${SESSION_COLUMNS} ${where.length === 0 ? sql`` : sql`WHERE ${sql.and(where)}`}) ${filter ? sql`WHERE ${filter}` : sql``} ORDER BY created_at, id`
  const decodeRows = (rows: ReadonlyArray<SessionSql>) =>
    decodeSessions(
      rows.map((row) => {
        const decoded = fromColumns(row, statuses.get(row.id) ?? "unknown", integrations.get(row.id))
        const at = row.tId === null || row.tEnd !== null ? undefined : prompted.get(row.tId)
        return at === undefined ? decoded : { ...decoded, turnPromptedAt: at }
      }),
    )
  const selectSessions = (where: ReadonlyArray<Statement.Fragment>, endedMains = false, filter?: Statement.Fragment) =>
    selectRaw([endedMains ? sql`(${notMain} OR ${endedMain})` : notMain, ...where], filter).pipe(
      Effect.flatMap(decodeRows),
    )
  const findSession = (id: string) => selectSessions([sql`a.id = ${id}`]).pipe(Effect.map((rows) => rows[0]))
  /** Get / result: an ended main conversation too. Mutations keep `findSession`, so they still cannot see it. */
  const readSession = (id: string) => selectSessions([sql`a.id = ${id}`], true).pipe(Effect.map((rows) => rows[0]))
  /** Any session, the main agent's too, with its current process. */
  const anySession = (id: string) =>
    selectRaw([sql`a.id = ${id}`]).pipe(
      Effect.map((rows) => {
        const row = rows[0]
        return row === undefined ? undefined : { row, current: currentOf(row) }
      }),
    )

  /** The main agent has its place: its latest process runs, and it is not moving to another terminal. */
  const placed = (projectIdValue: string, current: Current | undefined) =>
    current !== undefined && current.ended === null && current.start.terminal !== "" && !moving.has(projectIdValue)

  const findCoordinators = (project?: string) =>
    selectRaw([
      sql`a.id IN (SELECT entry_session_id FROM project ${project === undefined ? sql`` : sql`WHERE id = ${project}`})`,
    ]).pipe(
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) =>
          Effect.gen(function* () {
            const current = currentOf(row)
            const start = current?.start
            const [project] = yield* sql<{
              directory: string | null
            }>`SELECT directory FROM project WHERE id = ${row.project}`
            const [own] = yield* sql<{ directory: string }>`SELECT directory FROM session WHERE id = ${row.id}`
            const integration =
              integrations.get(row.id) ??
              (row.integration !== null ? (JSON.parse(row.integration) as Integration) : undefined)
            const pid = row.pid ?? start?.pid
            const here = placed(row.project, current)
            const directory = project?.directory || own?.directory
            return {
              id: row.id,
              projectId: row.project,
              harnessId: start?.harness ?? "",
              harnessSessionId: row.conversation ?? start?.resume ?? null,
              runtime: here ? start!.runtime : null,
              address: here ? JSON.stringify({ machine: start!.machine, id: start!.terminal }) : null,
              ...(directory ? { projectDirectory: directory } : {}),
              createdAt: row.createdAt,
              provider: start?.provider ?? null,
              model: start?.model ?? null,
              ...(start?.routing === undefined ? {} : { routing: start.routing }),
              ...(integration === undefined ? {} : { integration }),
              ...(pid === null || pid === undefined ? {} : { pid }),
              ...(row.readyAt === null ? {} : { ready: row.readyAt }),
            }
          }),
        ),
      ),
      Effect.flatMap(decodeCoordinators),
    )

  const inbox = (where: Statement.Fragment, order = sql`m.id`) =>
    sql<InboxSql>`SELECT m.id, m.recipient_session_id, m.kind, m.sender_session_id, m.content, m.status,
        te.data AS turn_end
      FROM inbox m LEFT JOIN event te ON te.id = m.result_event_id
      WHERE ${where} ORDER BY ${order}`.pipe(
      Effect.map((rows) => rows.map(toInbox)),
      Effect.flatMap(decodeInbox),
    )
  const inboxIn = (ids: ReadonlyArray<number>) => inbox(sql.in("m.id", ids))
  const findSend = (sessionId: string, status: InboxStatus) =>
    inbox(sql`m.recipient_session_id = ${sessionId} AND m.kind = 'send' AND m.status = ${storedStatus(status)}`)
  const entryOf = (projectIdValue: string) => sql`(SELECT entry_session_id FROM project WHERE id = ${projectIdValue})`

  /** The open turn of `sessionId`: its latest `turn.start` with no `turn.end`. */
  const openTurn = (sessionId: string) =>
    sql<{ id: number }>`SELECT t.id FROM event t WHERE t.id = (SELECT max(id) FROM event WHERE session_id = ${sessionId}
        AND type = 'turn.start') AND NOT EXISTS (SELECT 1 FROM event e WHERE e.turn_id = t.id AND e.type = 'turn.end')`.pipe(
      Effect.map((rows) => rows[0]?.id),
    )

  /**
   * Move the rows `where` selects to `to`, one `inbox.status` event each; returns the ids that moved. A row moved to
   * delivered names the turn its recipient has open (the turn that consumed it), if any.
   */
  const moveInbox = (where: Statement.Fragment, to: string) =>
    tx(
      Effect.gen(function* () {
        const rows = yield* sql<{
          id: number
          status: string
          recipient: string | null
          sender: string | null
        }>`SELECT id, status, recipient_session_id AS recipient, sender_session_id AS sender FROM inbox WHERE ${where}`
        const moved = rows.filter((r) => r.status !== to)
        if (moved.length === 0) return [] as ReadonlyArray<number>
        yield* sql`UPDATE inbox SET status = ${to} WHERE ${sql.in(
          "id",
          moved.map((r) => r.id),
        )}`
        const at = yield* now
        for (const r of moved) {
          const sessionId = r.recipient ?? r.sender!
          const turnId = to === "delivered" && r.recipient !== null ? yield* openTurn(r.recipient) : undefined
          yield* append({
            sessionId,
            type: "inbox.status",
            inboxId: r.id,
            turnId,
            at,
            data: { to },
          })
        }
        return moved.map((r) => r.id)
      }),
    )

  const insertInboxSql = (row: {
    readonly recipient: string | null
    readonly kind: string
    readonly sender: string | null
    readonly content: string
    readonly resultEventId?: number
    readonly status: string
  }) =>
    Effect.gen(function* () {
      const [inserted] = yield* sql<{ id: number }>`INSERT INTO inbox ${sql.insert({
        ...(row.recipient === null ? {} : { recipientSessionId: row.recipient }),
        kind: row.kind,
        ...(row.sender === null ? {} : { senderSessionId: row.sender }),
        content: row.content,
        ...(row.resultEventId === undefined ? {} : { resultEventId: row.resultEventId }),
        status: row.status,
      })} RETURNING id`
      const id = inserted!.id
      const at = yield* now
      const sessionId = row.recipient ?? row.sender!
      yield* append({ sessionId, type: "inbox.queued", inboxId: id, at, data: {} })
      // A task's delivery is the first turn that takes it (`linkTask`).
      if (row.status !== "pending" && row.kind !== "task")
        yield* append({
          sessionId,
          type: "inbox.status",
          inboxId: id,
          at,
          data: { to: row.status },
        })
      return id
    })

  /** A delivered task no turn took yet becomes the input of `turnId`, the turn that just started on it. */
  const linkTask = (sessionId: string, turnId: number, at: number) =>
    Effect.gen(function* () {
      const [task] = yield* sql<{ id: number }>`SELECT i.id FROM inbox i WHERE i.recipient_session_id = ${sessionId}
        AND i.kind = 'task' AND i.status = 'delivered'
        AND NOT EXISTS (SELECT 1 FROM event e WHERE e.inbox_id = i.id AND e.type = 'inbox.status')`
      if (task !== undefined)
        yield* append({
          sessionId,
          type: "inbox.status",
          inboxId: task.id,
          turnId,
          at,
          data: { to: "delivered" },
        })
    })

  /** End session `id`'s current process (`process.end`), unless it already ended or it has none. */
  const endProcess = (id: string, reason: EndReason, at?: number) =>
    Effect.gen(function* () {
      const found = yield* anySession(id)
      const current = found?.current
      if (current === undefined || current.ended !== null) return false
      yield* append({
        sessionId: id,
        type: "process.end",
        processId: current.id,
        ...(at === undefined ? {} : { at }),
        data: { reason },
      })
      integrations.delete(id)
      return true
    })

  /**
   * Append a `process.start`. One that follows a start with no terminal yet (the same process, its terminal now open)
   * carries over what that process reported while it started: its ready reports and conversation.
   */
  const startProcess = (id: string, start: ProcessStart, at?: number) =>
    Effect.gen(function* () {
      const before = (yield* anySession(id))?.current
      const opening =
        before !== undefined && before.ended === null && before.start.terminal === "" && start.terminal !== ""
      const data: Record<string, unknown> = {
        harness: start.harness,
        runtime: start.runtime,
        machine: start.machine,
        terminal: start.terminal,
        ...(start.provider ? { provider: start.provider } : {}),
        ...(start.model ? { model: start.model } : {}),
        ...(start.routing === undefined ? {} : { routing: start.routing }),
        ...(start.resume ? { resume: start.resume } : {}),
        ...(start.pid === undefined ? {} : { pid: start.pid }),
      }
      const processId = yield* append({
        sessionId: id,
        type: "process.start",
        data,
        ...(at === undefined ? {} : { at }),
      })
      if (opening) {
        const copied = yield* sql<{ at: number; type: "process.ready" | "process.conversation"; data: string }>`
          SELECT at, type, data FROM event
          WHERE process_id = ${before.id} AND type IN ('process.ready', 'process.conversation') ORDER BY id`
        for (const row of copied)
          yield* append({ sessionId: id, type: row.type, processId, at: row.at, data: JSON.parse(row.data) })
      } else integrations.delete(id)
      return processId
    })

  /** Close `id`'s open turn, or open and close one when none is open; returns the `turn.end` event. */
  const endTurn = (id: string, end: TurnEnd, at?: number) =>
    Effect.gen(function* () {
      const found = yield* anySession(id)
      const t = at ?? (yield* now)
      let turnId = yield* openTurn(id)
      if (turnId === undefined)
        turnId = yield* append({
          sessionId: id,
          type: "turn.start",
          processId: found?.current?.id,
          at: t,
          data: {},
        })
      prompted.delete(turnId)
      return yield* append({
        sessionId: id,
        type: "turn.end",
        processId: found?.current?.id,
        turnId,
        at: t,
        data: {
          status: end.status,
          ...(end.output === undefined ? {} : { output: end.output }),
          ...(end.report === undefined ? {} : { report: end.report }),
          ...(end.failure === undefined ? {} : { failure: end.failure }),
        },
      })
    })

  /**
   * A `send` goes to the subagent and always waits for it. The rest go to the sender's reply target
   * (`report_to_session_id` while it has not ended, else the project's entry session), `dropped` when it has no
   * place; with no entry session at all they are kept as the sender's own (dropped), so `vibest result` still reads
   * them. A result row points at the `turn.end` it reports: `end` when the caller is closing the turn, else one made
   * from `details` (status, error).
   */
  const insertInboxRow = (row: NewInboxRow, end?: TurnEnd, at?: number) =>
    Effect.gen(function* () {
      if (row.kind === "send") {
        const id = yield* insertInboxSql({
          recipient: row.sessionId,
          kind: "send",
          sender: null,
          content: row.message,
          status: "pending",
        })
        return (yield* inboxIn([id]))[0]!
      }
      const [route] = yield* sql<{ recipient: string | null; entry: number | null; project: string }>`SELECT
          CASE WHEN r.id IS NOT NULL AND r.ended_at IS NULL THEN r.id ELSE p.entry_session_id END AS recipient,
          (p.entry_session_id IS NOT NULL) AS entry, p.id AS project
        FROM session s JOIN project p ON p.id = s.project_id LEFT JOIN session r ON r.id = s.report_to_session_id
        WHERE s.id = ${row.sessionId}`
      const recipient = route?.recipient ?? null
      const [entry] =
        route === undefined
          ? []
          : yield* sql<{ id: string | null }>`SELECT entry_session_id AS id FROM project WHERE id = ${route.project}`
      const toEntry = recipient !== null && recipient === entry?.id
      const present =
        recipient !== null && (!toEntry || placed(route!.project, (yield* anySession(recipient))?.current))
      const resultEventId =
        row.kind === "result"
          ? yield* endTurn(
              row.sessionId,
              end ?? {
                status: roundStatus(row.details.status),
                ...(typeof row.details.error === "string" && row.details.error !== ""
                  ? { failure: failureOf(row.details.error)! }
                  : {}),
              },
              at,
            )
          : undefined
      const id = yield* insertInboxSql({
        recipient: recipient ?? row.sessionId,
        kind: row.kind,
        sender: row.sessionId,
        content: row.message,
        ...(resultEventId === undefined ? {} : { resultEventId }),
        status: present ? "pending" : "dropped",
      })
      return (yield* inboxIn([id]))[0]!
    })

  /**
   * Apply `patch` to session `id`: its columns, and an event for each change to its process or turn (schema.md:
   * the row is a read model). Times and the runtime status are not stored.
   */
  const updateSession = (id: string, patch: SessionPatch) =>
    Effect.gen(function* () {
      if (Object.keys(patch).length === 0) return
      const current = yield* findSession(id)
      if (current === undefined) return
      const next = { ...current, ...patch }
      remember(next)
      if (patch.name !== undefined && patch.name !== current.name)
        yield* sql`UPDATE session SET name = ${patch.name} WHERE id = ${id}`
      const ending = !!(next.metadata.archived || next.metadata.removed)
      if (ending && !(current.metadata.archived || current.metadata.removed))
        yield* sql`UPDATE session SET ended_at = ${yield* now} WHERE id = ${id} AND ended_at IS NULL`
      const p = (yield* anySession(id))!.current
      // A new choice, or a terminal opened for it, is a new process: its `process.start`.
      const routing = patch.metadata?.routing
      const choicePatched =
        (patch.harnessId !== undefined && patch.harnessId !== current.harnessId) ||
        (patch.provider !== undefined && patch.provider !== current.provider) ||
        (patch.model !== undefined && patch.model !== current.model) ||
        (patch.metadata !== undefined && JSON.stringify(routing) !== JSON.stringify(current.metadata.routing))
      const opened =
        (patch.startedAt !== undefined && patch.startedAt !== null) ||
        (patch.address !== undefined &&
          (patch.address.id !== current.address.id || patch.address.machine !== current.address.machine))
      if (p === undefined || choicePatched || opened) {
        const harnessChanged = next.harnessId !== current.harnessId
        const resume =
          patch.harnessSessionId !== undefined
            ? patch.harnessSessionId
            : harnessChanged
              ? null
              : current.harnessSessionId
        const nextRouting = patch.metadata !== undefined ? routing : current.metadata.routing
        yield* startProcess(
          id,
          {
            harness: next.harnessId,
            ...(next.provider ? { provider: next.provider } : {}),
            ...(next.model ? { model: next.model } : {}),
            ...(nextRouting === undefined ? {} : { routing: nextRouting }),
            runtime: current.runtime,
            machine: next.address.machine,
            terminal: next.address.id,
            ...(resume ? { resume } : {}),
          },
          patch.startedAt ?? undefined,
        )
      } else if (
        patch.harnessSessionId !== undefined &&
        patch.harnessSessionId !== null &&
        patch.harnessSessionId !== current.harnessSessionId
      ) {
        yield* append({
          sessionId: id,
          type: "process.conversation",
          processId: p.id,
          data: { conversation: patch.harnessSessionId },
        })
      }
      if (patch.exitedAt !== undefined && patch.exitedAt !== null && current.exitedAt === null)
        yield* endProcess(id, patch.end ?? "exited", patch.exitedAt)
      // The open turn: "open" starts one (on an open one it only moves the hand-over time); an end closes it.
      if (patch.turnState === "open") {
        const open = yield* openTurn(id)
        const at = next.turnPromptedAt || (yield* now)
        if (open !== undefined) {
          if (patch.turnPromptedAt !== undefined) prompted.set(open, at)
        } else {
          const turnId = yield* append({
            sessionId: id,
            type: "turn.start",
            processId: (yield* anySession(id))!.current?.id,
            at,
            data: {},
          })
          yield* linkTask(id, turnId, at)
        }
      } else if (patch.turnState !== undefined && patch.turnState !== "none" && current.turnState === "open") {
        const open = yield* openTurn(id)
        if (open !== undefined) prompted.delete(open)
        if (open !== undefined)
          yield* append({
            sessionId: id,
            type: "turn.end",
            processId: (yield* anySession(id))!.current?.id,
            turnId: open,
            data: { status: patch.turnState },
          })
      }
    })

  /**
   * Pending main-Agent-bound rows of `projectId`. A place guard is the main agent the caller read. `"absent"` drops
   * only while that project's main agent still has no place, so a launch that landed in between is left alone.
   */
  const dropWaiting = (
    projectIdValue: string,
    guard?: { readonly runtime: string; readonly address: string } | "absent",
  ) =>
    Effect.gen(function* () {
      if (guard !== undefined) {
        const [main] = yield* findCoordinators(projectIdValue)
        if (guard === "absent") {
          // A main agent moving to another terminal (`detachCoordinator`) has no place either, but its rows wait for it.
          if (main?.runtime || moving.has(projectIdValue)) return
        } else if (
          !main?.runtime ||
          !main.address ||
          main.runtime !== guard.runtime ||
          encodeAddress(main.address) !== guard.address
        )
          return
      }
      yield* moveInbox(
        sql`status = 'pending' AND kind NOT IN ${sql.literal(TO_SESSION)} AND recipient_session_id = ${entryOf(projectIdValue)}`,
        "dropped",
      )
    })

  /** Main agents whose live process is at this place (outside `except`), not moving. */
  const mainsAt = (runtime: string, address: RuntimeAddress, except?: string) =>
    Effect.gen(function* () {
      const rows = yield* sql<{ id: string; project: string }>`SELECT s.id, s.project_id AS project FROM session s
        JOIN project q ON q.entry_session_id = s.id
        JOIN event p ON p.id = ${currentStart(sql`s.id`)}
        WHERE json_extract(p.data, '$.runtime') = ${runtime} AND json_extract(p.data, '$.machine') = ${address.machine}
          AND json_extract(p.data, '$.terminal') = ${address.id}
          AND NOT EXISTS (SELECT 1 FROM event e WHERE e.process_id = p.id AND e.type = 'process.end')
          ${except === undefined ? sql`` : sql`AND s.project_id != ${except}`}`
      return rows.filter((r) => !moving.has(r.project))
    })

  /** Clear the place of every main agent at it (outside `except`), and drop what was waiting for them. */
  const clearMainAt = (runtime: string, address: RuntimeAddress, except?: string) =>
    Effect.gen(function* () {
      for (const main of yield* mainsAt(runtime, address, except)) {
        yield* endProcess(main.id, "exited")
        yield* dropWaiting(main.project)
      }
    })

  /** Some session id already starts with `short` (index-backed on the primary key). */
  const sessionPrefixTaken = (short: string) =>
    sql`SELECT 1 FROM session WHERE id >= ${short} AND id < ${`${short}~`} LIMIT 1`.pipe(
      Effect.map((rows) => rows.length > 0),
    )
  const unusedId = newId(sessionPrefixTaken)

  /** The conversation of session `id`'s current process, and that process. */
  const conversationOf = (id: string) =>
    anySession(id).pipe(
      Effect.map((found) => ({
        current: found?.current,
        conversation: found === undefined ? null : (found.row.conversation ?? found.current?.start.resume ?? null),
      })),
    )

  return {
    /**
     * The project `root` (a realpath) is: the project at that directory, else the one with a repository there (a
     * repository of a multi-repository project belongs to it). Reads only.
     */
    projectAt: (root: string) =>
      sql<{ id: string; directory: string }>`SELECT id, directory FROM project WHERE directory = ${root}
        UNION ALL SELECT p.id, p.directory FROM project_repository r JOIN project p ON p.id = r.project_id
          WHERE r.path = ${root} LIMIT 1`.pipe(
        Effect.map((rows) => rows[0]),
        Effect.orDie,
      ),

    /** A new project at `directory` (a realpath) with its repositories; its id. One already there is that project. */
    createProject: (directory: string, repositories: ReadonlyArray<RepositoryRow>) =>
      tx(
        Effect.gen(function* () {
          const id = yield* newId(projectPrefixTaken)
          // Two first requests can both miss projectAt; the second must not die on directory UNIQUE.
          yield* sql`INSERT INTO project ${sql.insert({ id, directory })} ON CONFLICT (directory) DO NOTHING`
          const [row] = yield* sql<{ id: string }>`SELECT id FROM project WHERE directory = ${directory}`
          yield* putRepositories(row!.id, repositories)
          return row!.id
        }),
      ).pipe(Effect.orDie),

    /** Project `id`'s repositories as they are now: origins refreshed, newly present ones added. */
    refreshRepositories: (id: string, repositories: ReadonlyArray<RepositoryRow>) =>
      tx(putRepositories(id, repositories)).pipe(Effect.orDie),

    /**
     * Projects with a directory whose repositories have exactly the origins `remotes` (non-null ones, as a set): where
     * a moved checkout came from. Whether that directory still exists is the caller's to check.
     */
    moveCandidates: (remotes: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const wanted = [...new Set(remotes)].sort()
        if (wanted.length === 0) return []
        const rows = yield* sql<{ id: string; directory: string; remote: string | null }>`SELECT p.id, p.directory,
            r.remote_url AS remote FROM project p JOIN project_repository r ON r.project_id = p.id
          WHERE p.directory IS NOT NULL AND p.id IN (SELECT project_id FROM project_repository WHERE ${sql.in("remote_url", wanted)})`
        const byProject = new Map<string, { directory: string; remotes: Set<string> }>()
        for (const row of rows) {
          const entry = byProject.get(row.id) ?? { directory: row.directory, remotes: new Set<string>() }
          if (row.remote !== null) entry.remotes.add(row.remote)
          byProject.set(row.id, entry)
        }
        return [...byProject]
          .filter(([, p]) => [...p.remotes].sort().join("\n") === wanted.join("\n"))
          .map(([id, p]) => ({ id, directory: p.directory }))
      }).pipe(Effect.orDie),

    /**
     * Project `id` now lives at `to` with `repositories`: its directory, its repository rows, and every session
     * directory under its old directory move with it. Returns the old directory.
     */
    moveProject: (id: string, to: string, repositories: ReadonlyArray<RepositoryRow>) =>
      tx(
        Effect.gen(function* () {
          const [row] = yield* sql<{ directory: string }>`SELECT directory FROM project WHERE id = ${id}`
          const from = row!.directory
          yield* sql`UPDATE project SET directory = ${to} WHERE id = ${id}`
          yield* sql`DELETE FROM project_repository WHERE project_id = ${id}`
          yield* putRepositories(id, repositories)
          yield* sql`UPDATE session SET directory = ${to} || substr(directory, ${from.length + 1})
              WHERE project_id = ${id} AND (directory = ${from} OR substr(directory, 1, ${from.length + 1}) = ${`${from}/`})`
          return from
        }),
      ).pipe(Effect.orDie),

    /** Where project `id` is; undefined for a project with no directory (migrated without one). */
    projectDirectory: (id: string) =>
      sql<{ directory: string | null }>`SELECT directory FROM project WHERE id = ${id}`.pipe(
        Effect.map((rows) => rows[0]?.directory ?? undefined),
        Effect.orDie,
      ),

    /** Where the session works: its worktree, or the one `vibest run --peer` shares. */
    sessionDirectory: (id: string) =>
      sql<{ directory: string }>`SELECT directory FROM session WHERE id = ${id}`.pipe(
        Effect.map((rows) => rows[0]?.directory),
        Effect.orDie,
      ),

    /**
     * The other sessions still live (not archived) that work in session `id`'s directory on the same machine: while
     * there is one, that directory stays.
     */
    liveSharers: (id: string) =>
      sql<{ id: string }>`SELECT o.id FROM session o JOIN session s ON s.id = ${id}
        WHERE o.id != s.id AND o.machine = s.machine AND o.directory = s.directory AND s.directory != ''
          AND o.ended_at IS NULL
        ORDER BY o.id`.pipe(
        Effect.map((rows) => rows.map((r) => r.id)),
        Effect.orDie,
      ),

    /**
     * The earliest created live session that shares `id`'s directory and was created before it: the one whose worktree
     * `id` joined with `--peer` (undefined for the session that owns it).
     */
    earlierSharer: (id: string) =>
      sql<{ id: string }>`SELECT o.id FROM session o JOIN session s ON s.id = ${id}
        WHERE o.id != s.id AND o.machine = s.machine AND o.directory = s.directory AND s.directory != ''
          AND o.ended_at IS NULL AND (o.created_at, o.rowid) < (s.created_at, s.rowid)
        ORDER BY o.created_at, o.rowid LIMIT 1`.pipe(
        Effect.map((rows) => rows[0]?.id),
        Effect.orDie,
      ),

    /**
     * Insert a subagent of project `project`, working in `cwd` (a `--peer` records the directory it shares), with its
     * `task` as its first inbox row (handed over by spawn itself, so recorded as delivered), unless `max` subagents are
     * already running (one transaction). Its results go to its parent, or with none to the project's entry session.
     */
    insertSession: (
      row: Omit<SessionRow, "projectId">,
      project: string,
      max?: number,
      cwd = "",
      task?: string,
      parentSessionId?: string,
    ) =>
      tx(
        Effect.gen(function* () {
          if (max !== undefined) {
            const n = (yield* selectRaw([notMain, sql`a.ended_at IS NULL`], running)).length
            if (n >= max) return false
          }
          const [entry] = yield* sql<{
            id: string | null
          }>`SELECT entry_session_id AS id FROM project WHERE id = ${project}`
          const reportTo = parentSessionId ?? (row.agent === "main" ? undefined : (entry?.id ?? undefined))
          const stopped = row.metadata.archived || row.metadata.removed
          yield* sql`INSERT INTO session ${sql.insert({
            id: row.id,
            projectId: project,
            ...(parentSessionId === undefined ? {} : { parentSessionId }),
            ...(reportTo === undefined ? {} : { reportToSessionId: reportTo }),
            role: row.agent,
            name: row.name,
            machine: row.address.machine,
            directory: cwd,
            archiveOnCompletion: row.metadata.archive ? 1 : 0,
            createdAt: row.createdAt,
            ...(stopped ? { endedAt: row.lastActive } : {}),
          })}`
          const processAt = row.startedAt ?? row.createdAt
          const processId = yield* startProcess(
            row.id,
            {
              harness: row.harnessId,
              ...(row.provider ? { provider: row.provider } : {}),
              ...(row.model ? { model: row.model } : {}),
              ...(row.metadata.routing === undefined ? {} : { routing: row.metadata.routing }),
              runtime: row.runtime,
              machine: row.address.machine,
              terminal: row.address.id,
              ...(row.harnessSessionId ? { resume: row.harnessSessionId } : {}),
            },
            processAt,
          )
          if (row.metadata.pid !== undefined || row.metadata.integration !== undefined)
            yield* append({
              sessionId: row.id,
              type: "process.ready",
              processId,
              at: row.metadata.ready ?? processAt,
              data: {
                ...(row.metadata.pid === undefined ? {} : { pid: row.metadata.pid }),
                ...(row.metadata.integration === undefined ? {} : { integration: row.metadata.integration }),
              },
            })
          if (row.exitedAt !== null)
            yield* append({
              sessionId: row.id,
              type: "process.end",
              processId,
              at: row.exitedAt,
              data: { reason: "exited" },
            })
          if (task !== undefined)
            yield* insertInboxSql({
              recipient: row.id,
              kind: "task",
              sender: parentSessionId ?? null,
              content: task,
              status: "delivered",
            })
          if (row.turnState !== "none") {
            const turnId = yield* append({
              sessionId: row.id,
              type: "turn.start",
              processId,
              at: row.turnPromptedAt,
              data: {},
            })
            yield* linkTask(row.id, turnId, row.turnPromptedAt)
            if (row.turnState !== "open")
              yield* append({
                sessionId: row.id,
                type: "turn.end",
                processId,
                turnId,
                at: row.turnPromptedAt,
                data: { status: row.turnState },
              })
          }
          remember(row)
          return true
        }),
      ).pipe(Effect.orDie),

    /**
     * The session `input` names: its full id, or a prefix of at least 8 characters that exactly one session's id
     * starts with (as people see ids: their first 8).
     */
    resolveSession: (input: string) =>
      Effect.gen(function* () {
        if (!/^[0-9a-f-]{8,36}$/.test(input))
          return yield* new NoSuchSession({
            id: input,
            message: /^[0-9a-f-]{1,7}$/.test(input)
              ? `${input}: a session id or a prefix of at least 8 of its characters`
              : `no session ${input}`,
          })
        const rows = yield* sql<{ id: string }>`SELECT id FROM session WHERE id >= ${input} AND id < ${`${input}~`}
          ORDER BY id LIMIT 11`.pipe(Effect.orDie)
        if (rows.length === 0) return yield* new NoSuchSession({ id: input, message: `no session ${input}` })
        if (rows.length > 1) return yield* new AmbiguousSession({ prefix: input, matches: rows.map((r) => r.id) })
        return rows[0]!.id
      }),

    /** A new session id: no other session's id starts with its first 8 characters. */
    newSessionId: unusedId.pipe(Effect.orDie),

    /** Any Agent: a caller is this row; `agent` is `coordinator` for a project's main agent, else its definition. */
    sessionIdentity: (id: string) =>
      sql<{ id: string; projectId: string; agent: string; harness: string }>`SELECT a.id, a.project_id,
          coalesce(json_extract(p.data, '$.harness'), '') AS harness,
          CASE WHEN q.entry_session_id = a.id THEN 'coordinator' ELSE a.role END AS agent
        FROM session a JOIN project q ON q.id = a.project_id
        LEFT JOIN event p ON p.id = ${currentStart(sql`a.id`)}
        WHERE a.id = ${id}`.pipe(
        Effect.map((rows) => rows[0]),
        Effect.orDie,
      ),

    getSession: (id: string) => readSession(id).pipe(Effect.orDie),

    /** How many sessions have a live status in memory (tests check it shrinks back once sessions end). */
    liveStatuses: Effect.sync(() => statuses.size),

    updateSession: (id: string, patch: SessionPatch) => tx(updateSession(id, patch)).pipe(Effect.orDie),

    /** `projectId` limits to one project; `stopped` includes subagents whose process is gone and ended main conversations. */
    listSessions: (filter: { projectId?: string; stopped?: boolean } = {}) =>
      selectSessions(
        filter.projectId === undefined ? [] : [sql`a.project_id = ${filter.projectId}`],
        filter.stopped === true,
        filter.stopped ? undefined : running,
      ).pipe(Effect.orDie),

    /**
     * Task text and latest turn for `ls` / `result`. The task is the session's `task` row. Unknown ids are absent.
     */
    sessionBriefs: (ids: ReadonlyArray<string>) =>
      (ids.length === 0
        ? Effect.succeed([] as ReadonlyArray<BriefRow>)
        : sql<BriefRow>`SELECT a.id,
            (SELECT i.content FROM inbox i WHERE i.recipient_session_id = a.id AND i.kind = 'task'
              ORDER BY i.id LIMIT 1) AS task,
            t.id AS turn_id,
            te.data AS end_data,
            te.at AS ended_at,
            (SELECT i.content FROM inbox i WHERE i.result_event_id = te.id ORDER BY i.id LIMIT 1) AS result_content,
            coalesce(json_extract(tr.data, '$.text'), json_extract(te.data, '$.output')) AS answer
          FROM session a
          LEFT JOIN event t ON t.id = (SELECT max(id) FROM event WHERE session_id = a.id AND type = 'turn.start')
          LEFT JOIN event te ON te.turn_id = t.id AND te.type = 'turn.end'
          LEFT JOIN event tr ON tr.id = json_extract(te.data, '$.report') AND tr.type = 'turn.reported'
          WHERE ${sql.in("a.id", ids)}`
      ).pipe(
        Effect.map((rows) => {
          const briefs = new Map<string, SessionBrief>()
          for (const row of rows) {
            const end = row.endData === null ? undefined : (JSON.parse(row.endData) as TurnEnd)
            const raw = row.turnId === null ? undefined : (end?.status ?? "working")
            const status = raw !== undefined && MESSAGE_STATUSES.has(raw) ? (raw as MessageStatusName) : undefined
            const summary =
              (row.resultContent === null ? undefined : summaryIn(row.resultContent)) ??
              (row.answer === null ? undefined : row.answer.split("\n")[0]) ??
              ""
            briefs.set(row.id, {
              task: row.task ?? null,
              latest: status === undefined ? null : { status, summary, endedAt: row.endedAt ?? null },
            })
          }
          return briefs
        }),
        Effect.orDie,
      ),

    /** Every project's main agent. */
    coordinators: findCoordinators().pipe(Effect.orDie),

    coordinatorOf: (projectIdValue: string) =>
      findCoordinators(projectIdValue).pipe(
        Effect.map((rows) => rows[0]),
        Effect.orDie,
      ),

    /** The project whose main agent is at this place, if any. */
    coordinatorAt: (runtime: string, address: RuntimeAddress) =>
      mainsAt(runtime, address).pipe(
        Effect.map((rows) => rows[0]?.project),
        Effect.orDie,
      ),

    /**
     * Point the project's main agent at this start, creating it on first use. Its id is stable across restarts and
     * harness switches; `fresh` (`vibest --new`) ends the current conversation and starts another (a new main session).
     * `start` is what scheduling chose (its `process.start`), and the PID its harness will have. Another project's main
     * agent still recorded at this pane loses the place, and both projects drop what was waiting; so does this one,
     * unless it is moving here (`detachCoordinator`): then what waits for it is delivered here.
     */
    coordinatorLaunch: (
      project: string,
      harness: HarnessId,
      fresh: boolean,
      location: { readonly runtime: string; readonly address: RuntimeAddress },
      start: {
        readonly provider?: string | undefined
        readonly model?: string | undefined
        readonly routing?: unknown
        /** The project directory. Stored as the main session's directory; never the key. */
        readonly projectDirectory?: string | undefined
        readonly pid?: number | undefined
      } = {},
    ) =>
      Effect.gen(function* () {
        const id = yield* unusedId
        return yield* tx(
          Effect.gen(function* () {
            yield* clearMainAt(location.runtime, location.address, project)
            const movingHere = moving.has(project)
            const [existing] = yield* sql<{
              main: string | null
            }>`SELECT entry_session_id AS main FROM project WHERE id = ${project}`
            const at = yield* now
            if (!existing?.main || fresh) {
              if (existing?.main) {
                yield* endProcess(existing.main, "archived", at)
                yield* sql`UPDATE session SET ended_at = ${at} WHERE id = ${existing.main}`
              }
              yield* sql`INSERT INTO session ${sql.insert({
                id,
                projectId: project,
                role: "main",
                name: "main",
                machine: location.address.machine,
                directory: start.projectDirectory ?? "",
                createdAt: at,
              })}`
              yield* sql`UPDATE project SET entry_session_id = ${id} WHERE id = ${project}`
            }
            const mainId = !existing?.main || fresh ? id : existing.main
            if (start.projectDirectory)
              yield* sql`UPDATE session SET directory = ${start.projectDirectory} WHERE id = ${mainId} AND directory = ''`
            const { current, conversation } = yield* conversationOf(mainId)
            if (current !== undefined && current.ended === null)
              yield* endProcess(mainId, movingHere ? "move" : "exited", at)
            const resume = !fresh && current?.start.harness === harness ? (conversation ?? undefined) : undefined
            yield* startProcess(
              mainId,
              {
                harness,
                ...(start.provider ? { provider: start.provider } : {}),
                ...(start.model ? { model: start.model } : {}),
                ...(start.routing ? { routing: start.routing } : {}),
                runtime: location.runtime,
                machine: location.address.machine,
                terminal: location.address.id,
                ...(resume === undefined ? {} : { resume }),
                // The PID the harness will have (vibest execs it): its integration's ready report comes later.
                ...(start.pid === undefined ? {} : { pid: start.pid }),
              },
              at,
            )
            moving.delete(project)
            if (!movingHere || fresh) yield* dropWaiting(project)
            return { sessionId: mainId, harnessSessionId: resume ?? null, projectId: project }
          }),
        )
      }).pipe(Effect.orDie),

    /** The harness's own conversation id (latest wins: a /clear changes it), written only when it changed; true when it did. */
    noteHarnessSession: (id: string, harnessSessionId: string) =>
      tx(
        Effect.gen(function* () {
          const { current, conversation } = yield* conversationOf(id)
          if (current === undefined || conversation === harnessSessionId) return false
          yield* append({
            sessionId: id,
            type: "process.conversation",
            processId: current.id,
            data: { conversation: harnessSessionId },
          })
          return true
        }),
      ).pipe(Effect.orDie),

    /**
     * The integration version and protocol session `id` (main agent or not) sent; true when they changed. Recorded
     * with its next `process.ready`.
     */
    noteIntegration: (id: string, integration: Integration) =>
      Effect.gen(function* () {
        const found = yield* anySession(id)
        if (found === undefined) return false
        const known =
          integrations.get(id) ??
          (found.row.integration === null ? undefined : (JSON.parse(found.row.integration) as Integration))
        if (known?.version === integration.version && known.protocol === integration.protocol) return false
        integrations.set(id, integration)
        return true
      }).pipe(Effect.orDie),

    /**
     * The harness's ready report (`ready`, and the pid it gave): a `process.ready` with the integration its requests
     * carry. A null only says the old harness's go with its process, which its `process.end` already records.
     */
    patchLive: (
      id: string,
      patch: {
        readonly pid?: number | null
        readonly ready?: number | null
      },
    ) =>
      tx(
        Effect.gen(function* () {
          const ready = typeof patch.ready === "number"
          if (!ready && typeof patch.pid !== "number") return
          const found = yield* anySession(id)
          const current = found?.current
          if (current === undefined) return
          const integration = integrations.get(id)
          yield* append({
            sessionId: id,
            type: "process.ready",
            processId: current.id,
            ...(ready ? { at: patch.ready as number } : {}),
            data: {
              ...(typeof patch.pid === "number" ? { pid: patch.pid } : {}),
              ...(ready ? {} : { pidOnly: true }),
              ...(!ready || integration === undefined ? {} : { integration }),
            },
          })
        }),
      ).pipe(Effect.orDie),

    /** When session `id`'s integration last reported ready (main agent or not); undefined when it has not since its start. */
    readyAt: (id: string) =>
      anySession(id).pipe(
        Effect.map((found) => found?.row.readyAt ?? undefined),
        Effect.orDie,
      ),

    /**
     * A restart in place: the harness in session `id`'s terminal got its SIGTERM, and the next one starts there on the
     * same conversation (`process.end` restart, then the same `process.start`). The open turn stays open.
     */
    restartProcess: (id: string) =>
      tx(
        Effect.gen(function* () {
          const { current, conversation } = yield* conversationOf(id)
          if (current === undefined) return
          yield* endProcess(id, "restart")
          const { resume: _, pid: __, ...start } = current.start
          yield* startProcess(id, { ...start, ...(conversation ? { resume: conversation } : {}) })
        }),
      ).pipe(Effect.orDie),

    /** End session `id`'s current process (`process.end` with `reason`); false when it had already ended. */
    endProcess: (id: string, reason: EndReason) => tx(endProcess(id, reason)).pipe(Effect.orDie),

    /** The last report wins. Another harness, or an id that is not a main agent, changes nothing. */
    reportCoordinatorSession: (sessionId: string, harness: HarnessId, harnessSessionId: string) =>
      tx(
        Effect.gen(function* () {
          const [main] = yield* sql<{
            id: string
          }>`SELECT entry_session_id AS id FROM project WHERE entry_session_id = ${sessionId}`
          const { current, conversation } = yield* conversationOf(sessionId)
          if (main === undefined || current === undefined || current.start.harness !== harness)
            return yield* Effect.logDebug(`main agent session report ignored for ${sessionId}`)
          if (conversation === harnessSessionId) return
          yield* append({
            sessionId,
            type: "process.conversation",
            processId: current.id,
            data: { conversation: harnessSessionId },
          })
        }),
      ).pipe(Effect.orDie),

    /**
     * The main agent leaves its place to move to another terminal (Project.StopCoordinator), before its harness is
     * stopped: no place, so its exit drops nothing (`clearCoordinator` no longer matches), and what waits for it stays
     * pending for the launch that follows. False when it is no longer at that place.
     */
    detachCoordinator: (projectIdValue: string, runtime: string, address: RuntimeAddress) =>
      Effect.gen(function* () {
        const here = (yield* mainsAt(runtime, address)).some((m) => m.project === projectIdValue)
        if (here) moving.add(projectIdValue)
        return here
      }).pipe(Effect.orDie),

    /** Undo `detachCoordinator` when its harness did not stop: back at its place, unless something took the row since. */
    reattachCoordinator: (projectIdValue: string, _runtime: string, _address: RuntimeAddress) =>
      Effect.sync(() => {
        moving.delete(projectIdValue)
      }),

    /** The runtime's `pane_closed` of a main agent's pane: it is gone, and what was waiting for it is dropped. */
    clearCoordinator: (runtime: string, address: RuntimeAddress) =>
      tx(clearMainAt(runtime, address)).pipe(Effect.asVoid, Effect.orDie),

    insertInbox: (row: NewInboxRow) => tx(insertInboxRow(row)).pipe(Effect.orDie),

    /** A Message to the subagent, unless it is archived (undefined then). One transaction, so `archiveIfNoPending` sees it or it sees the tombstone. */
    insertSend: (sessionId: string, message: string) =>
      tx(
        Effect.gen(function* () {
          const s = yield* findSession(sessionId)
          if (s === undefined || s.metadata.archived || s.metadata.removed) return undefined
          return yield* insertInboxRow({ sessionId, kind: "send", message, details: {} })
        }),
      ).pipe(Effect.orDie),

    /** End the subagent (`stopped`) unless a Message to it is pending; false then. One transaction with `insertSend`'s. */
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

    /**
     * Whether session `id`'s open turn was taken up, from what is stored (so after a vibestd restart too): it was typed,
     * or an inbox row was delivered into it. False with no open turn.
     */
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

    /** Latest time on any turn. Undefined: no turn yet. A turn end that is not newer was already delivered. */
    latestRoundAt: (sessionId: string) =>
      sql<{ at: number | null }>`SELECT max(at) AS at FROM event WHERE session_id = ${sessionId}
        AND type IN ('turn.start', 'turn.end')`.pipe(
        Effect.map((rows) => rows[0]?.at ?? undefined),
        Effect.orDie,
      ),

    /**
     * What a usage-limit move can resend for a session, and the parent that asked for it. `working` is the open
     * turn's input: its typed text, or the rows it consumed. `delivered`, used when that is empty, is the trailing run
     * of delivered task and send rows from one sender that no turn consumed, oldest first, joined with a blank line.
     */
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

    /** Open a user-typed turn. False when a turn is already open. One transaction with the session row. */
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

    /**
     * The harness's turn end, as received: one `turn.reported`, linked to the current process. No session lock. A check
     * later writes the `turn.end` that points at it.
     */
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

    /**
     * Session `id`'s latest `turn.reported`, if it came after the fence: `ready`, the current process's first
     * `process.ready` its integration wrote (none yet: no report counts); `start`, the current `process.start` (a
     * harness whose ready comes from the runtime). A harness ends a turn only after it is first ready, so a report at or
     * before the fence is an earlier harness's (a restart's or a move's). The first, not the latest: the same harness
     * reports ready again on a plugin reload or a new conversation, and its unconsumed report still counts. Ids, not
     * times: a ready's `at` can be backfilled.
     * Undefined too when a `turn.end` already consumed it: a report is one turn's end, taken once.
     */
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

    /**
     * Close the open turn with `end` (its whole `turn.end` data) and point the result at it, in one transaction with the
     * session row. `at`: no earlier than this (the reported turn end's time), so that end is not taken again.
     */
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

    /**
     * The project's main agent gave up rows `ids` without settling them (Inbox.poll: their lease ended): those still
     * `sending` go back to pending. Returns the rows put back.
     */
    releaseLeased: (projectIdValue: string, ids: ReadonlyArray<number>) =>
      ids.length === 0
        ? Effect.succeed([] as ReadonlyArray<number>)
        : moveInbox(
            sql`${sql.in("id", ids)} AND status = 'delivering' AND recipient_session_id = ${entryOf(projectIdValue)}`,
            "pending",
          ).pipe(Effect.orDie),

    /**
     * The main agent took `ids` (delivered) and gave back `release` (pending again): only its own rows, `sending` or
     * `pending`. Returns the rows now delivered.
     */
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

    /**
     * Once at start, one transaction (decision 2): a claimed row whose delivery a stop cut off may or may not have
     * arrived. Bound to a main agent whose harness polls (`pollHarnesses`, the adapters with inbox `poll`): pending
     * again, because that integration acks by row id and skips a row it already showed. Any other main-agent row:
     * failed. A subagent's rows: failed, with one notice per subagent (`notice` words it; its `inbox.queued` offers it);
     * nothing is delivered again. (Leases are memory only: none outlives the vibestd that granted it.)
     */
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

    /** Claimed deliveries must settle before a planned shutdown; pending Messages wait for the next vibestd. */
    sendingInbox: inbox(sql`m.status = 'delivering'`).pipe(
      Effect.map((rows) => rows.map((r) => ({ id: r.id, sessionId: r.sessionId, kind: r.kind }))),
      Effect.orDie,
    ),

    /** Projects with main-Agent-bound Messages waiting (the reconcile tick). */
    pendingProjects: sql<{
      project: string
    }>`SELECT DISTINCT s.project_id AS project FROM inbox m JOIN session s ON s.id = m.recipient_session_id
      WHERE m.status = 'pending' AND m.kind NOT IN ${sql.literal(TO_SESSION)}`.pipe(
      Effect.map((rows) => rows.map((r) => r.project)),
      Effect.orDie,
    ),

    dropWaiting: (projectIdValue: string, guard?: { readonly runtime: string; readonly address: string } | "absent") =>
      tx(dropWaiting(projectIdValue, guard)).pipe(Effect.asVoid, Effect.orDie),

    /**
     * Claim `pending` Messages. Main-Agent-bound claims also require the main agent still at the place the caller read.
     * Only the returned ids are delivered.
     */
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

    /** Move rows and return only the ids that were in `from`. A short result means the transition did not happen. */
    transitionInbox: (ids: ReadonlyArray<number>, status: InboxStatus, from: InboxStatus) =>
      (ids.length === 0
        ? Effect.succeed([] as ReadonlyArray<number>)
        : moveInbox(sql`${sql.in("id", ids)} AND status = ${storedStatus(from)}`, storedStatus(status))
      ).pipe(Effect.orDie),

    /** `from`: only rows still in that status (a claim and a drop never both land). Returns the rows it changed. */
    setInboxStatus: (ids: ReadonlyArray<number>, status: InboxStatus, from?: InboxStatus) =>
      Effect.gen(function* () {
        if (ids.length === 0) return [] as ReadonlyArray<InboxRow>
        const moved = yield* moveInbox(
          sql`${sql.in("id", ids)}${from ? sql` AND status = ${storedStatus(from)}` : sql``}`,
          storedStatus(status),
        )
        return moved.length === 0 ? [] : yield* inboxIn(moved)
      }).pipe(Effect.orDie),

    /** Newest row of `kind` for the subagent, whatever its status (`dropped` included). */
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
})

/** Name transforms the SQLite client must be built with: columns are the snake_case of the row fields. */
export const SQL_NAMES = { transformQueryNames: Str.camelToSnake, transformResultNames: Str.snakeToCamel } as const

export class Db extends Context.Service<Db, Effect.Success<typeof make>>()("vibest/Db") {
  /** Opened database over the provided SqlClient (a SQLite client built with `SQL_NAMES`). */
  static readonly layer = Layer.effect(
    Db,
    SqlClient.SqlClient.pipe(
      Effect.flatMap((sql) => sql.unsafe("PRAGMA foreign_keys = ON")),
      Effect.andThen(migrate),
      // journal_mode writes the header, so it runs only after acceptance. A refused existing file keeps its database and WAL bytes; -shm may change or be created.
      Effect.andThen(SqlClient.SqlClient.pipe(Effect.flatMap((sql) => sql.unsafe("PRAGMA journal_mode = WAL")))),
      // In WAL mode NORMAL cannot corrupt the database. A power loss may drop only the last commits. It removes an fsync per commit.
      Effect.andThen(SqlClient.SqlClient.pipe(Effect.flatMap((sql) => sql.unsafe("PRAGMA synchronous = NORMAL")))),
      // The open's one write, which two processes opening an empty database at once need (unit.test "two empty opens").
      Effect.andThen(
        SqlClient.SqlClient.pipe(Effect.flatMap((sql) => sql`UPDATE project SET directory = directory WHERE id = ''`)),
      ),
      Effect.andThen(make),
    ),
  )
}
