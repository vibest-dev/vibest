import { Automation } from "@vibest/schema/automation"
import { Json } from "@vibest/schema/json"
import { Effect, Option, Schema } from "effect"
import type { SqlClient } from "effect/sql"

export interface AutomationRow {
  readonly id: string
  readonly name: string
  readonly projectId: string
  readonly sessionId: string | null
  readonly directory: string
  readonly triggerJson: string
  readonly tz: string
  readonly actionJson: string
  readonly status: Automation.Status
  readonly nextDueAt: number | null
  readonly expiresAt: number | null
  readonly runCount: number
  readonly failures: number
  readonly lastRunAt: number | null
  readonly lastOutcome: Automation.Outcome | null
  readonly lastOutput: string | null
  readonly retryAt: number | null
  readonly stateJson: string | null
  readonly eventCursor: string | null
  readonly lastEventId: string | null
  readonly hasCursor: number
  readonly createdAt: number
  readonly updatedAt: number
}

const decodeTrigger = Schema.decodeUnknownSync(Automation.Trigger)
const decodeAction = Schema.decodeUnknownSync(Automation.Action)

const parseOptionalJson = (raw: string | null): Schema.Json | undefined =>
  raw === null ? undefined : Option.getOrUndefined(Json.parseJsonOption(raw))

export const toInfo = (row: AutomationRow): Automation.Info => {
  const state = parseOptionalJson(row.stateJson)

  return {
    id: Automation.ID.make(row.id),
    name: row.name,
    projectId: row.projectId,
    ...(row.sessionId !== null && { sessionId: row.sessionId }),
    directory: row.directory,
    trigger: decodeTrigger(JSON.parse(row.triggerJson)),
    tz: row.tz,
    action: decodeAction(JSON.parse(row.actionJson)),
    ...(row.expiresAt !== null && { expiresAt: row.expiresAt }),
    status: row.status,
    ...(row.nextDueAt !== null && { nextDueAt: row.nextDueAt }),
    runCount: row.runCount,
    failures: row.failures,
    ...(row.lastRunAt !== null && { lastRunAt: row.lastRunAt }),
    ...(row.lastOutcome !== null && { lastOutcome: row.lastOutcome }),
    ...(row.lastOutput !== null && { lastOutput: row.lastOutput }),
    ...(row.retryAt !== null && { retryAt: row.retryAt }),
    ...(state !== undefined && { state }),
    ...(row.hasCursor === 1 && {
      eventCursor: {
        cursor: row.eventCursor,
        ...(row.lastEventId !== null && { lastEventId: row.lastEventId }),
      },
    }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

const COLUMNS = `id, name, project_id, session_id, directory, trigger_json, tz, action_json,
  status, next_due_at, expires_at, run_count, failures, last_run_at,
  last_outcome, last_output, retry_at, state_json, event_cursor, last_event_id, has_cursor,
  created_at, updated_at`

export interface ListFilter {
  readonly projectId?: string | undefined
  readonly sessionId?: string | undefined
  readonly status?: Automation.Status | undefined
}

export const automationSql = (sql: SqlClient.SqlClient) => ({
  get: (id: string) =>
    sql.unsafe<AutomationRow>(`SELECT ${COLUMNS} FROM automation WHERE id = ?`, [id]).pipe(Effect.map((r) => r[0])),

  list: (filter: ListFilter = {}) => {
    const clauses: Array<string> = []
    const params: Array<string> = []

    if (filter.projectId !== undefined) {
      clauses.push("project_id = ?")
      params.push(filter.projectId)
    }

    if (filter.sessionId !== undefined) {
      clauses.push("session_id = ?")
      params.push(filter.sessionId)
    }

    if (filter.status !== undefined) {
      clauses.push("status = ?")
      params.push(filter.status)
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""

    return sql.unsafe<AutomationRow>(
      `SELECT ${COLUMNS} FROM automation ${where} ORDER BY created_at ASC, id ASC`,
      params,
    )
  },

  nextDue: () =>
    sql<{ at: number | null }>`SELECT MIN(
      CASE WHEN retry_at IS NOT NULL AND retry_at > next_due_at THEN retry_at ELSE next_due_at END
    ) AS at FROM automation WHERE status = 'active' AND next_due_at IS NOT NULL`.pipe(
      Effect.map((rows) => rows[0]?.at ?? undefined),
    ),

  dueAt: (now: number) =>
    sql.unsafe<AutomationRow>(
      `SELECT ${COLUMNS} FROM automation
        WHERE status = 'active'
          AND next_due_at IS NOT NULL
          AND next_due_at <= ?
          AND (retry_at IS NULL OR retry_at <= ?)
        ORDER BY next_due_at ASC, id ASC`,
      [now, now],
    ),

  activeEvents: () =>
    sql.unsafe<AutomationRow>(
      `SELECT ${COLUMNS} FROM automation WHERE status = 'active' AND next_due_at IS NULL ORDER BY created_at ASC, id ASC`,
    ),

  hasDedupKey: (automationId: string, dedupKey: string) =>
    sql<{ found: number }>`SELECT 1 AS found FROM automation_dedup
      WHERE automation_id = ${automationId} AND dedup_key = ${dedupKey} LIMIT 1`.pipe(
      Effect.map((rows) => rows.length > 0),
    ),
})
