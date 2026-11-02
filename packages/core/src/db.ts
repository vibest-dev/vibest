import { MessageStatus } from "@vibest/schema/model"
import { RuntimeAddress, InboxKind, InboxRow, InboxStatus, AgentStatus, TurnState } from "@vibest/schema/session"
// The only place with SQL (docs/design/schema.md: project, session, inbox, message). One schema, no migrations: an
// empty database gets it in one transaction; any other file is accepted only when its version pragmas and required
// objects already match. `inspectSchema` only reads;
// the driver must run it on a read-only connection before opening an existing file writable. One SQLite connection
// through effect/sql (the driver comes from #platform); rows are decoded with Schema; multi-row changes run in
// `sql.withTransaction`.
import { Clock, Context, Effect, Layer, Schema, String as Str } from "effect"
import { SqlClient } from "effect/sql"

import { roundSql } from "./db-rounds.ts"
import { HARNESS_IDS, type HarnessId } from "./harness.ts"
import { Routing } from "./plugins.ts"
export { RuntimeAddress, InboxKind, InboxRow, InboxStatus, AgentStatus, TurnState } from "@vibest/schema/session"

export const AddressJson = Schema.fromJsonString(RuntimeAddress)
export const encodeAddress = Schema.encodeSync(AddressJson)

/** The row's runtime kind and where its terminal lives: `{kind, machine, id}` (runtime-port.md §2). */
const encodeRuntime = (kind: string, address: RuntimeAddress) =>
  JSON.stringify({ kind, machine: address.machine, id: address.id })
/** The row's runtime kind and where its terminal lives: `{kind, machine, id}` (runtime-port.md §2). The id is the runtime's own grammar, opaque here; rows from before the port are rewritten by the herdr product's one-off migration, and any left decode as no terminal. */
const decodeRuntime = (raw: string): { readonly kind: string; readonly machine: string; readonly id: string } => {
  const value = JSON.parse(raw) as { readonly kind?: unknown; readonly machine?: unknown; readonly id?: unknown }
  return typeof value.kind === "string" && typeof value.machine === "string" && typeof value.id === "string"
    ? { kind: value.kind, machine: value.machine, id: value.id }
    : { kind: "", machine: "local", id: "" }
}
const addressJson = (runtime: { readonly kind: string; readonly machine: string; readonly id: string }) =>
  JSON.stringify({ machine: runtime.machine, id: runtime.id })
/** `encodedAddress` is `encodeAddress` output, the shape callers pass as a place guard. */
const runtimeMatching = (type: string, encodedAddress: string) =>
  encodeRuntime(type, JSON.parse(encodedAddress) as RuntimeAddress)

const Metadata = Schema.Struct({
  /**
   * A main agent's leased inbox rows (Inbox.poll), by row id: when each lease ends. An entry goes when its row is
   * acked, released, or its lease ended.
   */
  leases: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
  /** The harness integration's version the session's requests last carried (its plugin). */
  integrationVersion: Schema.optional(Schema.String),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  routing: Schema.optional(Routing),
  /** `vibest run --peer`: the session whose worktree this one shares. It never removes that worktree. */
  peer: Schema.optional(Schema.String),
  /** `vibest run --archive-on-completion`: archived once a completed result reached the coordinator. */
  archive: Schema.optional(Schema.Boolean),
  /** Only on rows from before `vibest run --access` was removed: read means it owns no worktree (remove.ts). */
  access: Schema.optional(Schema.Literals(["read", "write"])),
  /**
   * Owner only, with `worktreeName`, written before create: `worktrees/<worktreeRepository>/<worktreeName>`.
   * Both absent: `worktrees/<id>`. The repository name is not the repository key.
   */
  worktreeRepository: Schema.optional(Schema.String),
  /** Four lowercase hex. Chosen once; not a truncation of `id`. */
  worktreeName: Schema.optional(Schema.String),
  /** `vibest archive` (alias `rm`) ran: never resumed again, even when its worktree was kept. */
  archived: Schema.optional(Schema.Boolean),
  /** Same tombstone as `archived`. Older rows have only this; `vibest archive` still writes it. */
  removed: Schema.optional(Schema.Boolean),
  /** Archived with `--keep-worktree`: its last borrower's archive leaves the directory alone too. */
  keptWorktree: Schema.optional(Schema.Boolean),
  /**
   * What `vibest rm` closed (SPEC §8.6a), one record per pane, each written before its close: the pane, the PIDs the runtime
   * reported in it (its shell and foreground processes, never argv or env), and `exited` once signal 0 found every one
   * of them gone.
   */
  stop: Schema.optional(
    Schema.Array(Schema.Struct({ pane: Schema.String, pids: Schema.Array(Schema.Number), exited: Schema.Boolean })),
  ),
  /**
   * The check rule, on the open round: how many commands have finished, the stored outcome of the current result
   * (`mtime`), and one acceptance entry per finished command. `deliverFailed`: interrupt will deliver a failing
   * check instead of pasting it, and it stays until that result is written. Cleared when the round ends.
   */
  check: Schema.optional(
    Schema.Struct({
      mtime: Schema.Number,
      attempts: Schema.Number,
      ran: Schema.optional(Schema.Struct({ ok: Schema.Boolean, tail: Schema.String })),
      acceptance: Schema.Array(
        Schema.Struct({
          reviewer: Schema.Literal("check"),
          outcome: Schema.Literals(["pass", "fail"]),
          summary: Schema.String,
          time: Schema.Number,
        }),
      ),
      deliverFailed: Schema.optional(Schema.Boolean),
    }),
  ),
  /**
   * Real usage-limit tries for this session, oldest first: the (harness, provider) pairs that already hit a limit,
   * kept across moves and across a vibestd restart. Skips inside one move are not kept here.
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
/** A subagent (not a project's main session), in the shape its callers read: columns plus `session.metadata`. */
export const SessionRow = Schema.Struct({
  id: Schema.String,
  projectId: Schema.Number,
  agent: Schema.String,
  harnessId: Schema.Literals(HARNESS_IDS),
  harnessSessionId: Schema.NullOr(Schema.String),
  runtime: Schema.String,
  address: AddressJson,
  name: Schema.String,
  provider: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
  /** The runtime's status of the agent, last seen; `unknown` before the runtime reported it. */
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
export type SessionPatch = Partial<Omit<SessionRow, "id" | "projectId" | "agent" | "createdAt" | "runtime">>

/** The project's main agent. */
export const CoordinatorRow = Schema.Struct({
  id: Schema.String,
  projectId: Schema.Number,
  harnessId: Schema.Literals(HARNESS_IDS),
  harnessSessionId: Schema.NullOr(Schema.String),
  runtime: Schema.NullOr(Schema.String),
  address: Schema.NullOr(AddressJson),
  /** The project lookup key (`project.directory`). Not a filesystem path. */
  directory: Schema.String,
  /** The project directory, written at start. Absent on a row from before it was stored. */
  projectDirectory: Schema.optional(Schema.String),
  createdAt: Schema.Number,
  /** What scheduling chose when it last started (Project.StartMain): provider, model, routing. */
  provider: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
  routing: Schema.optional(Routing),
  /** The harness's PID: the `vibest` that exec'd it reported its own (Project.CoordinatorSession). Absent on older rows. */
  pid: Schema.optional(Schema.Number),
})
export type CoordinatorRow = typeof CoordinatorRow.Type

export type NewInboxRow = Omit<InboxRow, "id" | "status" | "createdAt">

/** "vibe", as a 32-bit application id. */
export const APPLICATION_ID = 0x76696265
export const SCHEMA_VERSION = 1

const SCHEMA = [
  `PRAGMA application_id = ${APPLICATION_ID}`,
  `PRAGMA user_version = ${SCHEMA_VERSION}`,
  `CREATE TABLE project (
    id              INTEGER PRIMARY KEY,
    directory       TEXT NOT NULL UNIQUE,
    main_session_id TEXT REFERENCES session (id)
  ) STRICT`,
  `CREATE TABLE session (
    id                 TEXT PRIMARY KEY,
    project_id         INTEGER NOT NULL REFERENCES project (id),
    parent_session_id  TEXT REFERENCES session (id),
    agent_type         TEXT NOT NULL,
    harness            TEXT NOT NULL,
    directory          TEXT NOT NULL,
    runtime            TEXT,
    harness_session_id TEXT,
    metadata           TEXT NOT NULL DEFAULT '{}',
    created_at         INTEGER NOT NULL,
    ended_at           INTEGER
  ) STRICT`,
  `CREATE INDEX session_project ON session (project_id)`,
  `CREATE INDEX session_parent ON session (parent_session_id)`,
  `CREATE TABLE inbox (
    id                   INTEGER PRIMARY KEY,
    recipient_session_id TEXT NOT NULL REFERENCES session (id),
    sender_type          TEXT NOT NULL,
    sender_id            TEXT,
    content              TEXT NOT NULL,
    result_message_id    INTEGER REFERENCES message (id),
    delivery_status      TEXT NOT NULL
  ) STRICT`,
  `CREATE INDEX inbox_pending ON inbox (recipient_session_id, delivery_status)`,
  `CREATE TABLE message (
    id          INTEGER PRIMARY KEY,
    session_id  TEXT NOT NULL REFERENCES session (id),
    inbox_id    INTEGER REFERENCES inbox (id),
    input       TEXT NOT NULL,
    output      TEXT,
    status      TEXT NOT NULL,
    metadata    TEXT NOT NULL DEFAULT '{}',
    started_at  INTEGER NOT NULL,
    ended_at    INTEGER
  ) STRICT`,
  `CREATE INDEX message_session ON message (session_id)`,
]

export class SchemaMismatch extends Schema.TaggedError<SchemaMismatch>()("SchemaMismatch", {
  version: Schema.Number,
  applicationId: Schema.Number,
  detail: Schema.optional(Schema.String),
}) {
  override get message() {
    const id = `0x${(this.applicationId >>> 0).toString(16)}`
    const extra = this.detail === undefined ? "" : `, ${this.detail}`
    return `vibest.db is not this vibest's schema (application_id ${id}, v${this.version}${extra}); stop vibestd and move ~/.vibest/vibest.db away to start over`
  }
}

/** The objects an existing file must have. Columns are not diffed. */
const REQUIRED = SCHEMA.flatMap((statement) => {
  const found = /^CREATE (TABLE|INDEX) (\w+)/.exec(statement)
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
  if (applicationId !== APPLICATION_ID || userVersion !== SCHEMA_VERSION || missing !== undefined) {
    return yield* mismatch(userVersion, applicationId, missing === undefined ? undefined : `missing ${missing.name}`)
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

const newId = Effect.sync(() =>
  Math.floor(Math.random() * 0x100000000)
    .toString(16)
    .padStart(8, "0"),
)

/**
 * What a subagent keeps in `session.metadata`: the session metadata, its label, provider and model,
 * when its process last started and was seen gone, and its last activity. Its status is live (memory only). Its open
 * turn is the `message` row with status `working`.
 * A result's parsed answer is that message's `metadata`, not a key here. `task` is its first inbox row.
 */
type SessionMetadata = SessionRow["metadata"] & {
  readonly name?: string
  readonly provider?: string | null
  readonly model?: string | null
  readonly startedAt?: number | null
  readonly exitedAt?: number | null
  readonly lastActive?: number
  /** The first inbox row, the task. Not a send: `inboxWithStatus` and the pending queue skip it. */
  readonly task?: number
}

type SessionColumns = {
  readonly id: string
  readonly project: number
  readonly definition: string
  readonly harness: string
  readonly runtimeJson: string | null
  readonly harnessSession: string | null
  readonly metadata: string
  readonly createdAt: number
  /** `session.ended_at`: a main conversation `vibest --new` ended. Subagents do not use it as `exitedAt`. */
  readonly sessionEnded: number | null
  /** Its latest turn, if any. `working` is the open turn. */
  readonly turnStatus: string | null
  readonly turnStarted: number | null
}

const fromColumns = (row: SessionColumns, status: AgentStatus) => {
  // `promptedSeq` is a pre-port metadata key no build reads; stripped so it leaves with the row's next write.
  const {
    name,
    provider,
    model,
    startedAt,
    exitedAt,
    promptedSeq: _promptedSeq,
    lastActive,
    task: _task,
    ...rest
  } = JSON.parse(row.metadata) as SessionMetadata & { readonly promptedSeq?: number }
  const located = row.runtimeJson === null ? undefined : decodeRuntime(row.runtimeJson)
  return {
    id: row.id,
    projectId: row.project,
    agent: row.definition,
    harnessId: row.harness,
    harnessSessionId: row.harnessSession,
    runtime: located?.kind ?? "",
    address: addressJson(located ?? { kind: "", machine: "local", id: "" }),
    name: name ?? (row.definition === "main" ? "main" : ""),
    provider: provider ?? null,
    model: model ?? null,
    status,
    startedAt: startedAt ?? null,
    exitedAt: row.definition === "main" ? row.sessionEnded : (exitedAt ?? null),
    turnState: row.turnStarted === null ? "none" : row.turnStatus === "working" ? "open" : (row.turnStatus ?? "none"),
    turnPromptedAt: row.turnStarted ?? 0,
    metadata: JSON.stringify(rest),
    createdAt: row.createdAt,
    lastActive: lastActive ?? row.createdAt,
  }
}
const decodeSessions = Schema.decodeUnknownEffect(Schema.Array(SessionRow))

const toMetadata = (
  session: Omit<
    SessionRow,
    | "id"
    | "projectId"
    | "agent"
    | "harnessId"
    | "harnessSessionId"
    | "runtime"
    | "address"
    | "status"
    | "turnState"
    | "turnPromptedAt"
    | "createdAt"
  >,
): SessionMetadata => ({
  ...session.metadata,
  name: session.name,
  provider: session.provider,
  model: session.model,
  startedAt: session.startedAt,
  exitedAt: session.exitedAt,
  lastActive: session.lastActive,
})

/** Public `sending` is the column value `delivering`. */
const storedStatus = (status: InboxStatus) => (status === "sending" ? "delivering" : status)

type InboxSql = {
  readonly id: number
  readonly recipientSessionId: string
  readonly senderType: string
  readonly senderId: string | null
  readonly content: string
  readonly resultMessageId: number | null
  readonly deliveryStatus: string
  readonly reportedOutput: string | null
  readonly reportedSession: string | null
  readonly reportedMetadata: string | null
}

/** Kind is not a column: a result points at a message; a user row is a send; system is a notice; anything else is a report. */
const toInbox = (row: InboxSql) => {
  const kind: InboxKind =
    row.resultMessageId !== null
      ? "result"
      : row.senderType === "system"
        ? "notice"
        : row.senderType === "user"
          ? "send"
          : "report"
  const sessionId =
    kind === "send"
      ? row.recipientSessionId
      : kind === "notice"
        ? (row.senderId ?? row.recipientSessionId)
        : (row.senderId ?? row.reportedSession ?? row.recipientSessionId)
  return {
    id: row.id,
    sessionId,
    kind,
    message: kind === "result" ? (row.reportedOutput ?? "") : row.content,
    details: kind === "result" ? (row.reportedMetadata ?? "{}") : "{}",
    status: row.deliveryStatus === "delivering" ? "sending" : row.deliveryStatus,
    createdAt: 0,
  }
}

const INBOX_FROM = `FROM inbox m
  JOIN session s ON s.id = m.recipient_session_id
  LEFT JOIN message msg ON msg.id = m.result_message_id`

const MESSAGE_STATUSES: ReadonlySet<string> = new Set(MessageStatus.literals)
type MessageStatusName = typeof MessageStatus.Type

/** metadata.summary when it is a string (including empty); otherwise the first line of output. */
const summaryOf = (metadata: string | null, output: string | null) => {
  if (metadata !== null && metadata !== "") {
    try {
      const summary = (JSON.parse(metadata) as { readonly summary?: unknown }).summary
      if (typeof summary === "string") return summary
    } catch {
      // Not JSON: the output's first line is the summary.
    }
  }
  return output?.split("\n")[0] ?? ""
}

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
  readonly messageStatus: string | null
  readonly messageOutput: string | null
  readonly messageMetadata: string | null
  readonly endedAt: number | null
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const now = Clock.currentTimeMillis
  const decodeInbox = Schema.decodeUnknownEffect(Schema.Array(InboxRow))
  const decodeCoordinators = Schema.decodeUnknownEffect(Schema.Array(CoordinatorRow))
  /** The runtime's last reported status per Agent: live, never stored (schema.md). */
  const statuses = new Map<string, AgentStatus>()
  /** No entry for `unknown` (what a missing one reads as) or an archived session (never live again): the map does not grow with ended sessions. */
  const remember = (row: Pick<SessionRow, "id" | "status" | "metadata">) => {
    if (row.status === "unknown" || row.metadata.archived || row.metadata.removed) statuses.delete(row.id)
    else statuses.set(row.id, row.status)
  }

  /** The project row for `key`, created on first use. The no-op `DO UPDATE` makes RETURNING answer for an existing row too. */
  const projectId = (key: string) =>
    Effect.gen(function* () {
      const rows = yield* sql<{ id: number }>`INSERT INTO project ${sql.insert({ directory: key })}
        ON CONFLICT (directory) DO UPDATE SET directory = excluded.directory RETURNING id`
      return rows[0]!.id
    })

  /** Subagents: not a main agent session, the current conversation or an earlier one (`vibest --new`). */
  const notMain = sql`a.agent_type != 'main'`
  /** A main conversation `vibest --new` replaced. The current main agent stays a coordinator, not a session row. */
  const endedMain = sql`a.agent_type = 'main' AND NOT EXISTS (SELECT 1 FROM project p WHERE p.main_session_id = a.id)`
  const selectSessions = (where: Parameters<typeof sql.and>[0], endedMains = false) =>
    sql<SessionColumns>`SELECT a.id, a.project_id AS project, a.agent_type AS definition, a.harness,
        a.runtime AS runtime_json, a.harness_session_id AS harness_session, a.metadata, a.created_at, a.ended_at AS session_ended,
        t.status AS turn_status, t.started_at AS turn_started
      FROM session a LEFT JOIN message t ON t.id = (SELECT max(id) FROM message WHERE session_id = a.id)
      WHERE ${endedMains ? sql`(${notMain} OR ${endedMain})` : notMain} ${where.length === 0 ? sql`` : sql`AND ${sql.and(where)}`} ORDER BY a.created_at, a.id`.pipe(
      Effect.flatMap((rows) => decodeSessions(rows.map((row) => fromColumns(row, statuses.get(row.id) ?? "unknown")))),
    )
  const findSession = (id: string) => selectSessions([sql`a.id = ${id}`]).pipe(Effect.map((rows) => rows[0]))
  /** Get / result: an ended main conversation too. Mutations keep `findSession`, so they still cannot see it. */
  const readSession = (id: string) => selectSessions([sql`a.id = ${id}`], true).pipe(Effect.map((rows) => rows[0]))

  const findCoordinators = (project?: number) =>
    sql<{
      id: string
      projectId: number
      harnessId: string
      harnessSessionId: string | null
      runtime: string | null
      directory: string
      createdAt: number
      metadata: string
    }>`
      SELECT a.id, a.project_id, a.harness AS harness_id, a.harness_session_id, a.runtime, a.directory, a.created_at, a.metadata
      FROM session a JOIN project p ON p.main_session_id = a.id ${project === undefined ? sql`` : sql`WHERE p.id = ${project}`} ORDER BY a.id`.pipe(
      Effect.flatMap((rows) =>
        decodeCoordinators(
          rows.map((row) => {
            const located = row.runtime === null ? undefined : decodeRuntime(row.runtime)
            const { provider, model, routing, projectDirectory, pid } = JSON.parse(row.metadata) as {
              provider?: string | null
              model?: string | null
              routing?: unknown
              projectDirectory?: unknown
              pid?: unknown
            }
            return {
              id: row.id,
              projectId: row.projectId,
              harnessId: row.harnessId,
              harnessSessionId: row.harnessSessionId,
              runtime: located?.kind ?? null,
              address: located === undefined ? null : addressJson(located),
              directory: row.directory,
              ...(typeof projectDirectory === "string" && projectDirectory !== "" ? { projectDirectory } : {}),
              createdAt: row.createdAt,
              provider: provider ?? null,
              model: model ?? null,
              ...(routing === undefined ? {} : { routing }),
              ...(typeof pid === "number" ? { pid } : {}),
            }
          }),
        ),
      ),
    )

  const inbox = (where: string, params: ReadonlyArray<unknown> = [], order = "m.id") =>
    sql
      .unsafe(
        `SELECT m.id, m.recipient_session_id, m.sender_type, m.sender_id, m.content, m.result_message_id, m.delivery_status,
      msg.output AS reported_output, msg.session_id AS reported_session, msg.metadata AS reported_metadata
      ${INBOX_FROM} WHERE ${where} ORDER BY ${order}`,
        params,
      )
      .pipe(
        Effect.map((rows) => (rows as ReadonlyArray<InboxSql>).map(toInbox)),
        Effect.flatMap(decodeInbox),
      )
  /** Removes these rows' entries from the project's main agent `metadata.leases`. */
  const forgetLeases = (projectId: number, ids: ReadonlyArray<number>) =>
    sql`UPDATE session SET metadata = json_patch(metadata, json_object('leases', json(${JSON.stringify(
      Object.fromEntries(ids.map((id) => [id, null])),
    )})))
      WHERE id = (SELECT main_session_id FROM project WHERE id = ${projectId})
        AND json_extract(metadata, '$.leases') IS NOT NULL`
  const inboxIn = (ids: ReadonlyArray<number>) => inbox(`m.id IN (${ids.map(() => "?").join(", ")})`, ids)
  const userSend = `m.sender_type = 'user' AND m.id != coalesce(json_extract(s.metadata, '$.task'), -1)`
  const findSend = (sessionId: string, status: InboxStatus) =>
    inbox(`m.recipient_session_id = ? AND ${userSend} AND m.delivery_status = ?`, [sessionId, storedStatus(status)])

  const { roundStatus, openRound, bindOpenRound, closeRound, latestRoundAt, coverRound, rescheduleSource } = roundSql(
    sql,
    now,
  )

  /**
   * A `send` goes to the subagent and always waits for it. The rest go to the sender's parent (`parent_session_id`, else
   * the project's main agent), `dropped` when it has no place; with no main agent at all they are kept as the sender's own (dropped), so `vibest result` still reads them.
   * A result's delivered text is that message's output (`content` stays empty). `status` is the round's end when the
   * caller is closing one; otherwise it comes from `details.status`.
   */
  const insertInboxRow = (row: NewInboxRow, status?: string) =>
    Effect.gen(function* () {
      const toAgent = row.kind === "send"
      const [main] = toAgent
        ? []
        : // The parent while it has not ended; after `vibest --new` ended it, the project's current main agent.
          yield* sql<{ main: string | null; present: number }>`WITH r AS (
              SELECT CASE WHEN parent.id IS NOT NULL AND parent.ended_at IS NULL THEN parent.id ELSE p.main_session_id END AS main
              FROM session s JOIN project p ON p.id = s.project_id LEFT JOIN session parent ON parent.id = s.parent_session_id
              WHERE s.id = ${row.sessionId})
            SELECT r.main AS main, (m.runtime IS NOT NULL) AS present FROM r LEFT JOIN session m ON m.id = r.main`
      const recipient = toAgent ? row.sessionId : (main?.main ?? row.sessionId)
      const result = !toAgent && row.kind === "result"
      const [inserted] = yield* sql<{ id: number }>`INSERT INTO inbox ${sql.insert({
        recipientSessionId: recipient,
        senderType: toAgent ? "user" : row.kind === "notice" ? "system" : "session",
        ...(toAgent ? {} : { senderId: row.sessionId }),
        content: result ? "" : row.message,
        ...(result
          ? {
              resultMessageId: yield* closeRound(
                row.sessionId,
                row.message,
                status ?? roundStatus(row.details.status),
                row.details,
              ),
            }
          : {}),
        deliveryStatus: toAgent || (main?.main && Number(main.present) === 1) ? "pending" : "dropped",
      })} RETURNING id`
      return (yield* inboxIn([inserted!.id]))[0]!
    })

  const updateSession = (id: string, patch: SessionPatch) =>
    Effect.gen(function* () {
      if (Object.keys(patch).length === 0) return
      const current = yield* findSession(id)
      if (current === undefined) return
      const next = { ...current, ...patch }
      remember(next)
      const [stored] = yield* sql<{ metadata: string }>`SELECT metadata FROM session WHERE id = ${id}`
      let task: number | undefined
      try {
        task = (JSON.parse(stored?.metadata ?? "{}") as SessionMetadata).task
      } catch {
        task = undefined
      }
      const metadata: SessionMetadata = { ...toMetadata(next), ...(task === undefined ? {} : { task }) }
      const columns: Record<string, unknown> = {
        harness: next.harnessId,
        harnessSessionId: next.harnessSessionId,
        metadata: JSON.stringify(metadata),
      }
      // The terminal lives inside the runtime column (`{kind, machine, id}`): recording where the session runs rewrites it.
      if (patch.address !== undefined) columns.runtime = encodeRuntime(current.runtime, patch.address)
      const stopped = !!(next.metadata.archived || next.metadata.removed)
      if (stopped !== !!(current.metadata.archived || current.metadata.removed))
        columns.endedAt = stopped ? next.lastActive : null
      yield* sql`UPDATE session SET ${sql.update(columns)} WHERE id = ${id}`
      // The open turn is the message with status `working`. "open" starts one (or re-stamps it) unless one is already
      // open (a user-typed prompt inserts its own); an end closes it.
      if (patch.turnState === "open") {
        if (current.turnState === "open") {
          yield* sql`UPDATE message SET started_at = ${next.turnPromptedAt} WHERE session_id = ${id} AND status = 'working'`
          yield* bindOpenRound(id)
        } else {
          const working = yield* sql<{
            id: number
          }>`SELECT id FROM message WHERE session_id = ${id} AND status = 'working' LIMIT 1`
          if (working.length === 0) yield* openRound(id, next.turnPromptedAt)
        }
      } else if (patch.turnState !== undefined && patch.turnState !== "none" && current.turnState === "open") {
        yield* sql`UPDATE message SET status = ${patch.turnState}, ended_at = ${yield* now} WHERE session_id = ${id} AND status = 'working'`
      }
    })

  /**
   * Pending main-Agent-bound rows of `projectId`. A place guard is the main agent the caller read. `"absent"` drops
   * only while that project's main agent still has no place, so a launch that landed in between is left alone.
   */
  const dropWaiting = (projectId: number, guard?: { readonly runtime: string; readonly address: string } | "absent") =>
    sql`UPDATE inbox SET delivery_status = 'dropped'
      WHERE delivery_status = 'pending' AND sender_type != 'user'
      AND recipient_session_id = (SELECT main_session_id FROM project WHERE id = ${projectId})
      ${
        guard === "absent"
          ? // A main agent moving to another terminal (`detachCoordinator`) has no place either, but its rows wait for it.
            sql`AND NOT EXISTS (SELECT 1 FROM session a JOIN project p ON p.main_session_id = a.id WHERE p.id = ${projectId} AND (a.runtime IS NOT NULL OR json_extract(a.metadata, '$.moving') = 1))`
          : guard
            ? sql`AND EXISTS (SELECT 1 FROM session a JOIN project p ON p.main_session_id = a.id WHERE p.id = ${projectId} AND a.runtime = ${runtimeMatching(guard.runtime, guard.address)})`
            : sql``
      }`

  /** Clear the place of every main agent at it (outside `except`), and drop what was waiting for them. */
  const clearMainAt = (runtime: string, address: string, except?: number) =>
    Effect.gen(function* () {
      const cleared = yield* sql<{ project: number }>`UPDATE session SET runtime = NULL
        WHERE id IN (SELECT main_session_id FROM project ${except === undefined ? sql`` : sql`WHERE id != ${except}`})
        AND runtime = ${runtimeMatching(runtime, address)} RETURNING project_id AS project`
      for (const row of cleared) yield* dropWaiting(row.project)
    })

  const unusedId = newId.pipe(
    Effect.flatMap((id) =>
      sql`SELECT 1 FROM session WHERE id = ${id}`.pipe(Effect.map((rows) => (rows.length > 0 ? undefined : id))),
    ),
    Effect.repeat({ until: (id) => id !== undefined }),
    Effect.map((id) => id!),
  )

  return {
    projectId: (key: string) => projectId(key).pipe(Effect.orDie),

    /** The project id for `key`, if one exists. Does not create a row. */
    projectByKey: (key: string) =>
      sql<{ id: number }>`SELECT id FROM project WHERE directory = ${key}`.pipe(
        Effect.map((rows) => rows[0]?.id),
        Effect.orDie,
      ),

    projectKey: (id: number) =>
      sql<{ directory: string }>`SELECT directory FROM project WHERE id = ${id}`.pipe(
        Effect.map((rows) => rows[0]?.directory),
        Effect.orDie,
      ),

    /** Where the session works: its worktree (a peer's is its owner's). */
    sessionDirectory: (id: string) =>
      sql<{ directory: string }>`SELECT directory FROM session WHERE id = ${id}`.pipe(
        Effect.map((rows) => rows[0]?.directory),
        Effect.orDie,
      ),

    /**
     * Insert a subagent of project `key`, working in `cwd` (a `--peer` borrows its owner's), with its
     * `task` as its first inbox row (handed over by spawn itself, so recorded as delivered), unless `max` subagents are
     * already running (one transaction).
     */
    insertSession: (
      row: Omit<SessionRow, "projectId">,
      key: string,
      max?: number,
      cwd = "",
      task?: string,
      parentSessionId?: string,
    ) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            if (max !== undefined) {
              const n =
                (yield* sql<{ n: number }>`SELECT count(*) AS n FROM session a
              WHERE ${notMain} AND json_extract(metadata, '$.exitedAt') IS NULL`)[0]?.n ?? 0
              if (n >= max) return false
            }
            const project = yield* projectId(key)
            const owner =
              row.metadata.peer === undefined
                ? undefined
                : (yield* sql<{ directory: string }>`SELECT directory FROM session WHERE id = ${row.metadata.peer}`)[0]
            const stopped = row.metadata.archived || row.metadata.removed
            yield* sql`INSERT INTO session ${sql.insert({
              id: row.id,
              projectId: project,
              ...(parentSessionId === undefined ? {} : { parentSessionId }),
              agentType: row.agent,
              harness: row.harnessId,
              directory: owner?.directory ?? cwd,
              runtime: encodeRuntime(row.runtime, row.address),
              harnessSessionId: row.harnessSessionId,
              metadata: JSON.stringify(toMetadata(row)),
              createdAt: row.createdAt,
              ...(stopped ? { endedAt: row.lastActive } : {}),
            })}`
            if (task !== undefined) {
              const [taskRow] = yield* sql<{ id: number }>`INSERT INTO inbox ${sql.insert({
                recipientSessionId: row.id,
                senderType: "user",
                content: task,
                deliveryStatus: "delivered",
              })} RETURNING id`
              yield* sql`UPDATE session SET metadata = json_set(metadata, '$.task', ${taskRow!.id}) WHERE id = ${row.id}`
            }
            if (row.turnState === "open") yield* openRound(row.id, row.turnPromptedAt)
            else if (row.turnState !== "none")
              yield* sql`INSERT INTO message ${sql.insert({
                sessionId: row.id,
                input: "",
                status: row.turnState,
                startedAt: row.turnPromptedAt,
                endedAt: row.turnPromptedAt,
              })}`
            remember(row)
            return true
          }),
        )
        .pipe(Effect.orDie),

    sessionExists: (id: string) =>
      sql`SELECT 1 FROM session WHERE id = ${id}`.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.orDie,
      ),

    /** Any Agent: a caller is this row; `agent` is `coordinator` for a project's main agent, else its definition. */
    sessionIdentity: (id: string) =>
      sql<{ id: string; projectId: number; agent: string; harness: string }>`SELECT a.id, a.project_id, a.harness,
          CASE WHEN p.main_session_id = a.id THEN 'coordinator' ELSE a.agent_type END AS agent
        FROM session a JOIN project p ON p.id = a.project_id WHERE a.id = ${id}`.pipe(
        Effect.map((rows) => rows[0]),
        Effect.orDie,
      ),

    getSession: (id: string) => readSession(id).pipe(Effect.orDie),

    /** How many sessions have a live status in memory (tests check it shrinks back once sessions end). */
    liveStatuses: Effect.sync(() => statuses.size),

    updateSession: (id: string, patch: SessionPatch) =>
      sql.withTransaction(updateSession(id, patch)).pipe(Effect.orDie),

    /** `projectId` limits to one project; `stopped` includes subagents whose process is gone and ended main conversations. */
    listSessions: (filter: { projectId?: number; stopped?: boolean } = {}) =>
      selectSessions(
        [
          ...(filter.projectId === undefined ? [] : [sql`a.project_id = ${filter.projectId}`]),
          ...(filter.stopped ? [] : [sql`json_extract(a.metadata, '$.exitedAt') IS NULL`]),
        ],
        filter.stopped === true,
      ).pipe(Effect.orDie),

    /**
     * Task text and latest message for `ls` / `result`. The task is the first delivered inbox row from the user or
     * the parent session. Unknown ids are absent.
     */
    sessionBriefs: (ids: ReadonlyArray<string>) =>
      (ids.length === 0
        ? Effect.succeed([] as ReadonlyArray<BriefRow>)
        : sql<BriefRow>`SELECT a.id,
            (SELECT i.content FROM inbox i
              WHERE i.recipient_session_id = a.id
                AND i.delivery_status = 'delivered'
                AND (i.sender_type = 'user' OR (i.sender_type = 'session' AND i.sender_id = a.parent_session_id))
              ORDER BY i.id LIMIT 1) AS task,
            m.status AS message_status,
            m.output AS message_output,
            m.metadata AS message_metadata,
            m.ended_at AS ended_at
          FROM session a
          LEFT JOIN message m ON m.id = (SELECT max(id) FROM message WHERE session_id = a.id)
          WHERE ${sql.in("a.id", ids)}`
      ).pipe(
        Effect.map((rows) => {
          const briefs = new Map<string, SessionBrief>()
          for (const row of rows) {
            const status =
              row.messageStatus !== null && MESSAGE_STATUSES.has(row.messageStatus)
                ? (row.messageStatus as MessageStatusName)
                : undefined
            briefs.set(row.id, {
              task: row.task ?? null,
              latest:
                status === undefined
                  ? null
                  : {
                      status,
                      summary: summaryOf(row.messageMetadata, row.messageOutput),
                      endedAt: row.endedAt ?? null,
                    },
            })
          }
          return briefs
        }),
        Effect.orDie,
      ),

    /** Every project's main agent. */
    coordinators: findCoordinators().pipe(Effect.orDie),

    coordinatorOf: (projectId: number) =>
      findCoordinators(projectId).pipe(
        Effect.map((rows) => rows[0]),
        Effect.orDie,
      ),

    /** The project whose main agent is at this place, if any. */
    coordinatorAt: (runtime: string, address: RuntimeAddress) =>
      sql<{ project: number }>`SELECT a.project_id AS project FROM session a JOIN project p ON p.main_session_id = a.id
        WHERE a.runtime = ${encodeRuntime(runtime, address)}`.pipe(
        Effect.map((rows) => rows[0]?.project),
        Effect.orDie,
      ),

    /**
     * Point the project's main agent at this start, creating it on first use. Its id is stable across restarts and
     * harness switches; `fresh` (`vibest --new`) ends the current conversation and starts another (a new main session).
     * `start` is what scheduling chose (kept in its metadata, for `vibest ls`), and the PID its harness will have. Another
     * project's main agent still recorded at this pane loses the place, and both projects drop what was waiting; so does
     * this one, unless it is moving here (`detachCoordinator`): then what waits for it is delivered here.
     */
    coordinatorLaunch: (
      key: string,
      harness: HarnessId,
      fresh: boolean,
      location: { readonly runtime: string; readonly address: RuntimeAddress },
      start: {
        readonly provider?: string | undefined
        readonly model?: string | undefined
        readonly routing?: unknown
        /** The project directory. Stored beside the key; never written into `directory`. */
        readonly projectDirectory?: string | undefined
        readonly pid?: number | undefined
      } = {},
    ) =>
      Effect.gen(function* () {
        const id = yield* unusedId
        const runtime = encodeRuntime(location.runtime, location.address)
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const project = yield* projectId(key)
            yield* clearMainAt(location.runtime, encodeAddress(location.address), project)
            // Whether the main agent is moving (its stop kept what waits for it), read with the main session id.
            const [existing] = yield* sql<{
              main: string | null
              moving: number | null
            }>`SELECT p.main_session_id AS main, json_extract(s.metadata, '$.moving') AS moving
                FROM project p LEFT JOIN session s ON s.id = p.main_session_id WHERE p.id = ${project}`
            if (!existing?.main || fresh) {
              const at = yield* now
              if (existing?.main)
                yield* sql`UPDATE session SET runtime = NULL, ended_at = ${at} WHERE id = ${existing.main}`
              yield* sql`INSERT INTO session ${sql.insert({
                id,
                projectId: project,
                agentType: "main",
                harness,
                directory: key,
                runtime,
                createdAt: at,
              })}`
              yield* sql`UPDATE project SET main_session_id = ${id} WHERE id = ${project}`
            }
            const metadata = JSON.stringify({
              provider: start.provider ?? null,
              model: start.model ?? null,
              pid: start.pid ?? null,
              moving: null,
              ...(start.routing ? { routing: start.routing } : {}),
              ...(start.projectDirectory ? { projectDirectory: start.projectDirectory } : {}),
            })
            const [saved] = yield* sql<{ id: string; harnessSession: string | null }>`UPDATE session SET
                harness_session_id = CASE WHEN ${fresh ? 1 : 0} OR harness != ${harness} THEN NULL ELSE harness_session_id END,
                harness = ${harness}, runtime = ${runtime}, metadata = json_patch(metadata, ${metadata})
              WHERE id = (SELECT main_session_id FROM project WHERE id = ${project}) RETURNING id, harness_session_id AS harness_session`
            if (!existing?.moving || fresh) yield* dropWaiting(project)
            return { sessionId: saved!.id, harnessSessionId: saved!.harnessSession, projectId: project }
          }),
        )
      }).pipe(Effect.orDie),

    /** The conversation an integration reports for session `id` (main agent or not): the latest wins. True when it changed. */
    /** The integration version the session's requests carry, written only when it changed; true when it did. */
    noteIntegrationVersion: (id: string, version: string) =>
      sql<{ id: string }>`UPDATE session SET metadata = json_set(metadata, '$.integrationVersion', ${version})
        WHERE id = ${id} AND json_extract(metadata, '$.integrationVersion') IS NOT ${version} RETURNING id`.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.orDie,
      ),

    /** The harness's own conversation id (latest wins: a /clear changes it), written only when it changed; true when it did. */
    noteHarnessSession: (id: string, harnessSessionId: string) =>
      sql<{ id: string }>`UPDATE session SET harness_session_id = ${harnessSessionId}
        WHERE id = ${id} AND harness_session_id IS NOT ${harnessSessionId} RETURNING id`.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.orDie,
      ),

    /** The last report wins. Another harness, or an id that is not a main agent, changes nothing. */
    reportCoordinatorSession: (sessionId: string, harness: HarnessId, harnessSessionId: string) =>
      sql`UPDATE session SET harness_session_id = ${harnessSessionId}
        WHERE id = ${sessionId} AND id IN (SELECT main_session_id FROM project) AND harness = ${harness} RETURNING id`.pipe(
        Effect.tap((rows) =>
          rows.length === 0 ? Effect.logDebug(`main agent session report ignored for ${sessionId}`) : Effect.void,
        ),
        Effect.asVoid,
        Effect.orDie,
      ),

    /**
     * The main agent leaves its place to move to another terminal (Project.StopCoordinator), before its harness is
     * stopped: no place, so its exit drops nothing (`clearCoordinator` no longer matches), and what waits for it stays
     * pending for the launch that follows. False when it is no longer at that place.
     */
    detachCoordinator: (projectId: number, runtime: string, address: RuntimeAddress) =>
      sql<{ id: string }>`UPDATE session SET runtime = NULL, metadata = json_patch(metadata, '{"moving":true}')
        WHERE id = (SELECT main_session_id FROM project WHERE id = ${projectId})
        AND runtime = ${encodeRuntime(runtime, address)} RETURNING id`.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.orDie,
      ),

    /** Undo `detachCoordinator` when its harness did not stop: back at its place, unless something took the row since. */
    reattachCoordinator: (projectId: number, runtime: string, address: RuntimeAddress) =>
      sql`UPDATE session SET runtime = ${encodeRuntime(runtime, address)}, metadata = json_patch(metadata, '{"moving":null}')
        WHERE id = (SELECT main_session_id FROM project WHERE id = ${projectId})
        AND runtime IS NULL AND json_extract(metadata, '$.moving') = 1`.pipe(Effect.asVoid, Effect.orDie),

    /** The runtime's `pane_closed` of a main agent's pane: it is gone, and what was waiting for it is dropped. */
    clearCoordinator: (runtime: string, address: RuntimeAddress) =>
      sql.withTransaction(clearMainAt(runtime, encodeAddress(address))).pipe(Effect.asVoid, Effect.orDie),

    insertInbox: (row: NewInboxRow) => insertInboxRow(row).pipe(Effect.orDie),

    /** A Message to the subagent, unless it is archived (undefined then). One transaction, so `archiveIfNoPending` sees it or it sees the tombstone. */
    insertSend: (sessionId: string, message: string) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const s = yield* findSession(sessionId)
            if (s === undefined || s.metadata.archived || s.metadata.removed) return undefined
            return yield* insertInboxRow({ sessionId, kind: "send", message, details: {} })
          }),
        )
        .pipe(Effect.orDie),

    /** End the subagent (`stopped`) unless a Message to it is pending; false then. One transaction with `insertSend`'s. */
    archiveIfNoPending: (id: string) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const s = yield* findSession(id)
            if (s === undefined || (yield* findSend(id, "pending")).length > 0) return false
            yield* updateSession(id, {
              metadata: { ...s.metadata, archived: true, removed: true },
              lastActive: yield* now,
            })
            return true
          }),
        )
        .pipe(Effect.orDie),

    closeTurn: (id: string, end: TurnState, patch: SessionPatch) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* updateSession(id, { turnState: end, ...patch })
          }),
        )
        .pipe(Effect.orDie),

    /** Latest time on any message. Undefined: no round yet. A result file that is not newer was already delivered. */
    latestRoundAt: (sessionId: string) => latestRoundAt(sessionId).pipe(Effect.orDie),

    /** The newest message ends no earlier than `at`, so that result file is not newer than the round it closed. */
    coverRound: (sessionId: string, at: number) => coverRound(sessionId, at).pipe(Effect.orDie),

    /** What a usage-limit move can resend for a session, and the parent that asked for it. */
    rescheduleSource: (id: string) => rescheduleSource(id).pipe(Effect.orDie),

    /** Open a user-typed round. False when a round is already working. One transaction with the session row. */
    beginUserTurn: (id: string, text: string, patch: SessionPatch) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const open = yield* sql<{
              id: number
            }>`SELECT id FROM message WHERE session_id = ${id} AND status = 'working' LIMIT 1`
            if (open.length > 0) return false
            const at = patch.turnPromptedAt ?? (yield* now)
            yield* sql`INSERT INTO message ${sql.insert({ sessionId: id, input: text, status: "working", startedAt: at })}`
            yield* updateSession(id, { ...patch, turnState: "open", turnPromptedAt: at })
            return true
          }),
        )
        .pipe(Effect.orDie),

    /** Close the open round (output, status, metadata) and point the result at it, in one transaction with the session row. */
    finishTurn: (id: string, patch: SessionPatch, row: NewInboxRow) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const inserted = yield* insertInboxRow(
              row,
              row.kind === "result" ? roundStatus(patch.turnState) : undefined,
            )
            yield* updateSession(id, patch)
            return inserted
          }),
        )
        .pipe(Effect.orDie),

    pendingInbox: (sessionId: string) => findSend(sessionId, "pending").pipe(Effect.orDie),

    inboxWithStatus: (sessionId: string, status: InboxStatus) => findSend(sessionId, status).pipe(Effect.orDie),

    coordinatorPending: (projectId: number) =>
      inbox(
        `m.sender_type != 'user' AND m.delivery_status = 'pending' AND m.recipient_session_id = (SELECT main_session_id FROM project WHERE id = ?)`,
        [projectId],
      ).pipe(Effect.orDie),

    /** Leases rows handed to the project's main agent until `until` (`metadata.leases`, one entry per row). */
    leaseRows: (projectId: number, ids: ReadonlyArray<number>, until: number) =>
      ids.length === 0
        ? Effect.void
        : sql`UPDATE session SET metadata = json_patch(metadata, json_object('leases', json(${JSON.stringify(
            Object.fromEntries(ids.map((id) => [id, until])),
          )})))
            WHERE id = (SELECT main_session_id FROM project WHERE id = ${projectId})`.pipe(Effect.asVoid, Effect.orDie),

    /**
     * Ends the leases of the project's main agent that ran out by `now` (every one when `now` is undefined): their rows
     * still `sending` go back to pending, and their entries go. Returns the rows put back.
     */
    endLeases: (projectId: number, now: number | undefined) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const main = sql`(SELECT main_session_id FROM project WHERE id = ${projectId})`
            const leases = yield* sql<{ id: string; until: number }>`SELECT l.key AS id, l.value AS until
              FROM session s, json_each(s.metadata, '$.leases') l WHERE s.id = ${main}`
            const ended = leases.filter((l) => now === undefined || l.until <= now).map((l) => Number(l.id))
            if (ended.length === 0) return [] as ReadonlyArray<number>
            yield* forgetLeases(projectId, ended)
            const back = yield* sql<{ id: number }>`UPDATE inbox SET delivery_status = 'pending'
              WHERE ${sql.in("id", ended)} AND delivery_status = 'delivering' AND recipient_session_id = ${main}
              RETURNING id`
            return back.map((r) => r.id)
          }),
        )
        .pipe(Effect.orDie),

    /**
     * The main agent took `ids` (delivered) and gave back `release` (pending again): only its own rows, `sending` or
     * `pending`. Their leases go. Returns the rows now delivered.
     */
    settleLeased: (projectId: number, ids: ReadonlyArray<number>, release: ReadonlyArray<number>) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const main = sql`(SELECT main_session_id FROM project WHERE id = ${projectId})`
            yield* forgetLeases(projectId, [...ids, ...release])
            if (release.length > 0)
              yield* sql`UPDATE inbox SET delivery_status = 'pending'
                WHERE ${sql.in("id", release)} AND delivery_status = 'delivering' AND recipient_session_id = ${main}`
            if (ids.length === 0) return [] as ReadonlyArray<InboxRow>
            const done = yield* sql<{ id: number }>`UPDATE inbox SET delivery_status = 'delivered'
              WHERE ${sql.in("id", ids)} AND delivery_status IN ('delivering', 'pending') AND sender_type != 'user'
                AND recipient_session_id = ${main}
              RETURNING id`
            return done.length === 0 ? [] : yield* inboxIn(done.map((r) => r.id))
          }),
        )
        .pipe(Effect.orDie),

    /**
     * After a restart: a claimed main-agent-bound row whose delivery was cut off may or may not have arrived, so it
     * failed; one bound to a main agent whose harness polls (`pollHarnesses`, the adapters with inbox `poll`) is back to
     * pending, because that integration acks by row id and skips a row it already showed. Subagent-bound
     * `delivering` rows stay for `check`. (Their leases went when the database opened: Db.layer.)
     */
    recoverSending: (pollHarnesses: ReadonlyArray<string>) =>
      sql`UPDATE inbox SET delivery_status = CASE WHEN EXISTS (SELECT 1 FROM session s
          JOIN project p ON p.main_session_id = s.id
          WHERE s.id = inbox.recipient_session_id AND ${pollHarnesses.length === 0 ? sql`0` : sql.in("s.harness", pollHarnesses)})
        THEN 'pending' ELSE 'failed' END
        WHERE delivery_status = 'delivering' AND sender_type != 'user'`.pipe(Effect.asVoid, Effect.orDie),

    /** Claimed deliveries must settle before a planned shutdown; pending Messages wait for the next vibestd. */
    sendingInbox: inbox(`m.delivery_status = 'delivering'`).pipe(
      Effect.map((rows) => rows.map((r) => ({ id: r.id, sessionId: r.sessionId, kind: r.kind }))),
      Effect.orDie,
    ),

    /** Projects with main-Agent-bound Messages waiting (the reconcile tick). */
    pendingProjects: sql<{
      project: number
    }>`SELECT DISTINCT s.project_id AS project FROM inbox m JOIN session s ON s.id = m.recipient_session_id
      WHERE m.delivery_status = 'pending' AND m.sender_type != 'user'`.pipe(
      Effect.map((rows) => rows.map((r) => r.project)),
      Effect.orDie,
    ),

    dropWaiting: (projectId: number, guard?: { readonly runtime: string; readonly address: string } | "absent") =>
      dropWaiting(projectId, guard).pipe(Effect.asVoid, Effect.orDie),

    /**
     * Claim `pending` Messages. Main-Agent-bound claims also require the main agent still at the place the caller read.
     * Only the returned ids are delivered.
     */
    claim: (
      ids: ReadonlyArray<number>,
      guard?: {
        readonly projectId: number
        readonly runtime: string
        readonly address: string
        readonly harnessId?: string
      },
    ) =>
      (ids.length === 0
        ? Effect.succeed([] as ReadonlyArray<number>)
        : sql<{
            id: number
          }>`UPDATE inbox SET delivery_status = 'delivering' WHERE ${sql.in("id", ids)} AND delivery_status = 'pending'
            ${guard ? sql`AND EXISTS (SELECT 1 FROM session a JOIN project p ON p.main_session_id = a.id WHERE p.id = ${guard.projectId} AND a.runtime = ${runtimeMatching(guard.runtime, guard.address)}${guard.harnessId ? sql` AND a.harness = ${guard.harnessId}` : sql``})` : sql``}
            RETURNING id`.pipe(Effect.map((rows) => rows.map((r) => r.id)))
      ).pipe(Effect.orDie),

    /** Move rows and return only the ids that were in `from`. A short result means the transition did not happen. */
    transitionInbox: (ids: ReadonlyArray<number>, status: InboxStatus, from: InboxStatus) =>
      Effect.gen(function* () {
        if (ids.length === 0) return [] as ReadonlyArray<number>
        const rows = yield* sql<{ id: number }>`UPDATE inbox SET delivery_status = ${storedStatus(status)}
          WHERE ${sql.in("id", ids)} AND delivery_status = ${storedStatus(from)} RETURNING id`
        return rows.map((r) => r.id)
      }).pipe(Effect.orDie),

    /** `from`: only rows still in that status (a claim and a drop never both land). Returns the rows it changed. */
    setInboxStatus: (ids: ReadonlyArray<number>, status: InboxStatus, from?: InboxStatus) =>
      Effect.gen(function* () {
        if (ids.length === 0) return [] as ReadonlyArray<InboxRow>
        const rows = yield* sql<{ id: number }>`UPDATE inbox SET delivery_status = ${storedStatus(status)}
          WHERE ${sql.in("id", ids)}${from ? sql` AND delivery_status = ${storedStatus(from)}` : sql``} RETURNING id`
        return rows.length === 0 ? [] : yield* inboxIn(rows.map((r) => r.id))
      }).pipe(Effect.orDie),

    /** Newest row of `kind` for the subagent, whatever its status (`dropped` included). */
    latestInbox: (sessionId: string, kind: InboxKind) =>
      (kind === "send"
        ? inbox(`m.recipient_session_id = ? AND ${userSend}`, [sessionId], "m.id DESC LIMIT 1")
        : kind === "notice"
          ? inbox(`m.sender_type = 'system' AND m.sender_id = ?`, [sessionId], "m.id DESC LIMIT 1")
          : kind === "result"
            ? inbox(`m.result_message_id IS NOT NULL AND m.sender_id = ?`, [sessionId], "m.id DESC LIMIT 1")
            : inbox(
                `m.sender_type = 'session' AND m.result_message_id IS NULL AND m.sender_id = ?`,
                [sessionId],
                "m.id DESC LIMIT 1",
              )
      ).pipe(
        Effect.map((rows) => rows[0]),
        Effect.orDie,
      ),

    projectOfSession: (sessionId: string) =>
      sql<{ project: number }>`SELECT project_id AS project FROM session WHERE id = ${sessionId}`.pipe(
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
      // No lease outlives the vibestd that granted it (Inbox.poll).
      Effect.andThen(
        SqlClient.SqlClient.pipe(
          Effect.flatMap(
            (sql) => sql`UPDATE session SET metadata = json_remove(metadata, '$.leases')
              WHERE json_extract(metadata, '$.leases') IS NOT NULL`,
          ),
        ),
      ),
      Effect.andThen(make),
    ),
  )
}
