import { rebuild } from "@vibest/core/journal"
import { PROJECTION_TABLES } from "@vibest/core/projectors"
import { Catalog, CATALOG_VERSION, decodeRow, encodeData, type FactType } from "@vibest/schema/event"
import { randomId } from "@vibest/schema/id"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql"

import { decodeRow as decodeBefore, type Row as RowBefore } from "./before/event.ts"
import { project as projectBefore, PROJECTION_SCHEMA as SCHEMA_BEFORE } from "./before/projectors.ts"

export class RewriteFailed extends Schema.TaggedError<RewriteFailed>()("RewriteFailed", {
  message: Schema.String,
}) {}

type Json = Record<string, unknown>
type Table = ReadonlyArray<Record<string, unknown>>

export type NewRow = {
  readonly aggregate: string
  readonly seq: number
  readonly at: number
  readonly type: string
  readonly data: string
}

export type Plan = {
  readonly rows: ReadonlyArray<NewRow>
  readonly dropped: ReadonlyArray<RowBefore>
  readonly closed: ReadonlyArray<{ readonly session: string; readonly execution: number; readonly report: number }>
}

const without = (data: Json, ...keys: ReadonlyArray<string>) =>
  Object.fromEntries(Object.entries(data).filter(([key]) => !keys.includes(key)))

const renamed = (data: Json, from: string, to: string) =>
  Object.fromEntries(Object.entries(data).map(([key, value]) => [key === from ? to : key, value]))

const notice = (kind: unknown) => (kind === "report" || kind === "result" ? "notice" : kind)

const reportOutcome = (report: Json) =>
  report["interrupted"] === true ? "interrupted" : typeof report["error"] === "string" ? "failed" : "completed"

const endFromReport = (execution: number, report: Json) => {
  const outcome = reportOutcome(report)
  return {
    execution,
    outcome,
    ...(outcome === "failed" ? { failure: { message: report["error"] } } : {}),
    reply: report["text"],
  }
}

const sessionCreated = (data: Json, project: string | null) => {
  const { origin, ...rest } = without(data, "reportTo", "archiveOnCompletion", "archiveOnIdle")
  const next: Json = { project, ...renamed(rest, "role", "agent") }
  if (origin === undefined) return next
  return { ...next, origin: renamed(without(origin as Json, "parent"), "reportTo", "session") }
}

export const planRewrite = (old: ReadonlyArray<RowBefore>, ledger: string): Plan => {
  const parsed = old.map((row) => ({ row, data: JSON.parse(row.data) as Json }))
  const referenced = new Set<number>()
  const open = new Map<string, number>()
  for (const { row, data } of parsed) {
    if (row.type === "turn.ended" && typeof data["report"] === "number") referenced.add(data["report"])
    if (row.type === "turn.started" && row.session_id !== null) open.set(row.session_id, row.seq)
    if (row.type === "turn.ended" && row.session_id !== null && open.get(row.session_id) === data["turn"])
      open.delete(row.session_id)
  }
  const reports = new Map(parsed.filter(({ row }) => row.type === "turn.reported").map((p) => [p.row.seq, p.data]))
  const latestReport = new Map<string, number>()
  for (const { row } of parsed) {
    const execution = row.session_id === null ? undefined : open.get(row.session_id)
    if (row.type === "turn.reported" && !referenced.has(row.seq) && execution !== undefined && row.seq > execution)
      latestReport.set(row.session_id!, row.seq)
  }
  const closing = new Set(latestReport.values())
  const rows: Array<NewRow> = []
  const dropped: Array<RowBefore> = []
  const closed: Array<Plan["closed"][number]> = []
  for (const { row, data } of parsed) {
    const aggregate = row.type === "outbox.queued" ? ledger : (row.session_id ?? row.project_id ?? ledger)
    const keep = (type: string, next: Json) =>
      rows.push({ aggregate, seq: row.seq, at: row.at, type, data: JSON.stringify(next) })
    switch (row.type) {
      case "turn.started":
        keep("execution.started", data)
        break
      case "turn.ended": {
        const report = typeof data["report"] === "number" ? reports.get(data["report"]) : undefined
        const rest = renamed(renamed(without(data, "report"), "turn", "execution"), "status", "outcome")
        keep("execution.ended", report === undefined ? rest : { reply: report["text"], ...rest })
        break
      }
      case "turn.reported":
        if (closing.has(row.seq)) {
          const execution = open.get(row.session_id!)!
          keep("execution.ended", endFromReport(execution, data))
          closed.push({ session: row.session_id!, execution, report: row.seq })
        } else if (!referenced.has(row.seq)) dropped.push(row)
        break
      case "inbox.queued":
        keep(row.type, { ...without(data, "turn"), kind: notice(data["kind"]) })
        break
      case "inbox.moved":
        keep(row.type, renamed(data, "turn", "execution"))
        break
      case "session.created":
        keep(row.type, sessionCreated(data, row.project_id))
        break
      case "outbox.queued":
        keep(row.type, { ...data, session: row.session_id, kind: notice(data["kind"]) })
        break
      default:
        keep(row.type, data)
    }
  }
  return { rows, dropped, closed }
}

const aggregateKind = (row: NewRow, ledger: string, old: RowBefore) =>
  row.aggregate === ledger
    ? "ledger"
    : old.session_id !== null && row.aggregate === old.session_id
      ? "session"
      : "project"

export const canonical = (plan: Plan, old: ReadonlyArray<RowBefore>, ledger: string) =>
  Effect.gen(function* () {
    const bySeq = new Map(old.map((row) => [row.seq, row]))
    const failures: Array<string> = []
    const rows: Array<NewRow> = []
    for (const row of plan.rows) {
      const where = `event ${row.seq} (${bySeq.get(row.seq)!.type} → ${row.type})`
      const fact = yield* decodeRow(row).pipe(Effect.result)
      if (fact._tag === "Failure") {
        failures.push(`${where}: ${fact.failure.message}`)
        continue
      }
      const definition = Catalog[row.type as FactType]
      const kind = aggregateKind(row, ledger, bySeq.get(row.seq)!)
      if (definition.aggregate !== kind) {
        failures.push(`${where}: belongs to a ${definition.aggregate} aggregate, its envelope gives a ${kind}`)
        continue
      }
      rows.push({ ...row, data: yield* encodeData(definition, fact.success.data as never).pipe(Effect.orDie) })
    }
    if (failures.length > 0)
      return yield* new RewriteFailed({
        message: `${failures.length} rewritten events do not decode with the new catalog:\n${failures.join("\n")}`,
      })
    return rows
  })

const OLD_TABLES = ["project", "project_repository", "session", "process", "turn", "inbox", "machine", "peer", "outbox"]

const renameKeys = (row: Record<string, unknown>, names: Record<string, string>) =>
  Object.fromEntries(Object.entries(row).map(([key, value]) => [names[key] ?? key, value]))

const asNew: Record<string, (row: Record<string, unknown>) => Record<string, unknown> | undefined> = {
  session: (row) => renameKeys(without(row, "archive_on_idle"), { role: "agent", turn_id: "execution_id" }),
  process: (row) => without(row, "ready_seq"),
  turn: (row) => renameKeys(without(row, "report_seq"), { status: "outcome", answer: "reply" }),
  inbox: (row) => ({
    ...renameKeys(without(row, "recipient_session_id"), { turn_id: "execution_id" }),
    session_id: row["recipient_session_id"] ?? row["sender_session_id"],
    kind: notice(row["kind"]),
  }),
  outbox: (row) => ({ ...row, kind: notice(row["kind"]) }),
}

const NEW_NAME: Record<string, string> = { turn: "execution" }

const keyOf = (table: string, row: Record<string, unknown>) =>
  PROJECTION_TABLES[(NEW_NAME[table] ?? table) as keyof typeof PROJECTION_TABLES]
    .split(", ")
    .map((column) => String(row[column]))
    .join(" ")

const sorted = (row: Record<string, unknown>) =>
  JSON.stringify(Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b))))

export const replayBefore = (sql: SqlClient.SqlClient, old: ReadonlyArray<RowBefore>) =>
  Effect.gen(function* () {
    yield* sql.unsafe(`CREATE TABLE event (
      seq INTEGER PRIMARY KEY, at INTEGER NOT NULL, type TEXT NOT NULL, project_id TEXT, session_id TEXT,
      data TEXT NOT NULL) STRICT`)
    for (const statement of SCHEMA_BEFORE) yield* sql.unsafe(statement)
    for (const row of old) {
      yield* sql`INSERT INTO event (seq, at, type, project_id, session_id, data)
        VALUES (${row.seq}, ${row.at}, ${row.type}, ${row.project_id}, ${row.session_id}, ${row.data})`
      const fact = yield* decodeBefore(row).pipe(
        Effect.mapError(
          (e) => new RewriteFailed({ message: `the old log does not decode with event catalog 1: ${e.message}` }),
        ),
      )
      yield* projectBefore(fact, sql)
    }
    const tables: Record<string, Table> = {}
    for (const table of OLD_TABLES) tables[table] = yield* sql.unsafe<Record<string, unknown>>(`SELECT * FROM ${table}`)
    return tables
  })

const dumpNew = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const tables: Record<string, Table> = {}
    for (const table of Object.keys(PROJECTION_TABLES))
      tables[table] = yield* sql.unsafe<Record<string, unknown>>(`SELECT * FROM ${table}`)
    return tables
  })

export const referee = (before: Record<string, Table>, after: Record<string, Table>, plan: Plan) => {
  const closedEnds = new Map(
    plan.closed.map((c) => {
      const end = plan.rows.find((row) => row.seq === c.report)!
      return [`${c.session} ${c.execution}`, { at: end.at, data: JSON.parse(end.data) as Json }]
    }),
  )
  const droppedAt = new Map<string, Set<number>>()
  for (const row of plan.dropped)
    if (row.session_id !== null) droppedAt.set(row.session_id, (droppedAt.get(row.session_id) ?? new Set()).add(row.at))
  const differences: Array<string> = []
  const expected: Array<string> = []
  for (const table of OLD_TABLES) {
    const name = NEW_NAME[table] ?? table
    const old = new Map(before[table]!.map((row) => asNew[table]?.(row) ?? row).map((row) => [keyOf(table, row), row]))
    const now = new Map(after[name]!.map((row) => [keyOf(table, row), row]))
    for (const [key, row] of old) {
      const ended = name === "execution" ? closedEnds.get(key) : undefined
      const want =
        ended === undefined
          ? row
          : {
              ...row,
              outcome: ended.data["outcome"],
              reply: ended.data["reply"] ?? null,
              failure: (ended.data["failure"] as Json | undefined)?.["message"] ?? null,
              ended_at: ended.at,
            }
      const got = now.get(key)
      if (got === undefined) {
        differences.push(`${name} ${key}: before ${sorted(row)}, after nothing`)
        continue
      }
      if (sorted(want) === sorted(got)) {
        if (ended !== undefined) expected.push(`${name} ${key}: closed by its late reply (${String(want["outcome"])})`)
        continue
      }
      const lastActive = name === "session" && droppedAt.get(String(row["id"]))?.has(Number(row["active_at"]))
      if (lastActive && sorted({ ...want, active_at: got["active_at"] }) === sorted(got)) {
        expected.push(
          `session ${key}: last active ${String(got["active_at"])}, was the dropped reply at ${String(row["active_at"])}`,
        )
        continue
      }
      differences.push(`${name} ${key}: before ${sorted(want)}, after ${sorted(got)}`)
    }
    for (const [key, row] of now)
      if (!old.has(key)) differences.push(`${name} ${key}: before nothing, after ${sorted(row)}`)
  }
  return { differences, expected }
}

const EVENT = `CREATE TABLE event_next (
    position  INTEGER PRIMARY KEY AUTOINCREMENT,
    aggregate TEXT    NOT NULL,
    seq       INTEGER NOT NULL,
    at        INTEGER NOT NULL,
    type      TEXT    NOT NULL,
    data      TEXT    NOT NULL,
    UNIQUE (aggregate, seq)
  ) STRICT`

export type Report = {
  readonly events: number
  readonly written: number
  readonly dropped: number
  readonly expected: ReadonlyArray<string>
}

export const oldShape = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const columns = yield* sql<{ name: string }>`SELECT name FROM pragma_table_info('event')`
    const has = (name: string) => columns.some((column) => column.name === name)
    const [catalog] = yield* sql<{ value: string }>`SELECT value FROM meta WHERE key = 'catalog'`
    if (has("aggregate")) return yield* new RewriteFailed({ message: "the database is already in the new event shape" })
    if (!has("session_id") || Number(catalog?.value) !== 1)
      return yield* new RewriteFailed({ message: "the database is not a vibest event ledger with event catalog 1" })
  })

export const rewrite = (scratch: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* oldShape(sql)
        const old = yield* sql<RowBefore>`SELECT seq, at, type, project_id, session_id, data FROM event ORDER BY seq`
        const before = yield* replayBefore(scratch, old)
        const ledger = randomId()
        const plan = planRewrite(old, ledger)
        const rows = yield* canonical(plan, old, ledger)
        const [last] = yield* sql<{ seq: number }>`SELECT seq FROM sqlite_sequence WHERE name = 'event'`
        yield* sql.unsafe(EVENT)
        for (const row of rows)
          yield* sql`INSERT INTO event_next (position, aggregate, seq, at, type, data)
            VALUES (${row.seq}, ${row.aggregate}, ${row.seq}, ${row.at}, ${row.type}, ${row.data})`
        yield* sql`DELETE FROM sqlite_sequence WHERE name = 'event_next'`
        yield* sql`INSERT INTO sqlite_sequence (name, seq) VALUES ('event_next', ${last?.seq ?? 0})`
        yield* sql.unsafe("DROP TABLE event")
        yield* sql.unsafe("ALTER TABLE event_next RENAME TO event")
        yield* sql.unsafe(`CREATE TRIGGER event_no_update BEFORE UPDATE ON event
          BEGIN SELECT RAISE(ABORT, 'event is append-only'); END`)
        yield* sql`INSERT INTO meta (key, value) VALUES ('ledger', ${ledger})`
        yield* sql`UPDATE meta SET value = ${String(CATALOG_VERSION)} WHERE key = 'catalog'`
        yield* rebuild
        const { differences, expected } = referee(before, yield* dumpNew(sql), plan)
        if (differences.length > 0)
          return yield* new RewriteFailed({
            message: `the rebuilt read model differs from the old one in ${differences.length} rows:\n${differences.join("\n")}`,
          })
        return { events: old.length, written: rows.length, dropped: plan.dropped.length, expected } satisfies Report
      }),
    )
  })
