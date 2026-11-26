import { Automation } from "@vibest/schema/automation"
import { Json } from "@vibest/schema/json"
import { Effect, Option, Schema } from "effect"
import type { SqlClient } from "effect/sql"

export interface AutomationRow {
  readonly id: string
  readonly projectId: string
  readonly sessionId: string | null
  readonly directory: string
  readonly name: string
  readonly trigger: string
  readonly tz: string
  readonly action: string
  readonly status: Automation.Status
  readonly nextDueAt: number | null
  readonly expiresAt: number | null
  readonly runCount: number
  readonly failures: number
  readonly lastRunAt: number | null
  readonly lastMessageId: string | null
  readonly lastOutcome: Automation.Outcome | null
  readonly lastOutput: string | null
  readonly retryAt: number | null
  readonly state: string | null
  readonly eventPosition: string | null
  readonly timeCreated: number
  readonly timeUpdated: number
}

export interface InsertAutomationRow {
  readonly id: Automation.ID
  readonly projectId: string
  readonly sessionId: string | null
  readonly directory: string
  readonly name: string
  readonly trigger: Automation.Trigger
  readonly tz: string
  readonly action: Automation.Action
  readonly nextDueAt: number | null
  readonly expiresAt: number | null
  readonly eventPosition: Automation.EventPosition | null
  readonly timeCreated: number
  readonly timeUpdated: number
}

export interface SettlePatch {
  readonly status?: Automation.Status | undefined
  readonly nextDueAt?: number | null | undefined
  readonly runCount?: number | undefined
  readonly failures?: number | undefined
  readonly lastRunAt?: number | null | undefined
  readonly lastMessageId?: string | null | undefined
  readonly lastOutcome?: Automation.Outcome | null | undefined
  readonly lastOutput?: string | null | undefined
  readonly retryAt?: number | null | undefined
  readonly state?: Schema.Json | null | undefined
  readonly eventPosition?: Automation.EventPosition | null | undefined
  readonly timeUpdated?: number | undefined
}

export interface SettleOptions {
  readonly evenIfPaused?: boolean | undefined
}

export interface ResumePatch {
  readonly status: "active" | "done"
  readonly nextDueAt: number | null
  readonly timeUpdated: number
}

const decodeTrigger = Schema.decodeUnknownSync(Automation.Trigger)
const decodeAction = Schema.decodeUnknownSync(Automation.Action)
const decodeEventPosition = Schema.decodeUnknownOption(Automation.EventPosition)

const parseOptionalJson = (raw: string | null): Schema.Json | undefined =>
  raw === null ? undefined : Option.getOrUndefined(Json.parseJsonOption(raw))

export const parseEventPosition = (raw: string | null): Automation.EventPosition | null => {
  if (raw === null) return null

  return Option.getOrNull(Option.flatMap(Json.parseJsonOption(raw), decodeEventPosition))
}

export const toInfo = (row: AutomationRow): Automation.Info => {
  const state = parseOptionalJson(row.state)
  const eventPosition = parseEventPosition(row.eventPosition)

  return {
    id: Automation.ID.make(row.id),
    name: row.name,
    projectId: row.projectId,
    ...(row.sessionId !== null && { sessionId: row.sessionId }),
    directory: row.directory,
    trigger: decodeTrigger(JSON.parse(row.trigger)),
    tz: row.tz,
    action: decodeAction(JSON.parse(row.action)),
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
    ...(eventPosition !== null && { eventPosition }),
    createdAt: row.timeCreated,
    updatedAt: row.timeUpdated,
  }
}

const COLUMNS = `id, project_id, session_id, directory, name, trigger, tz, action,
  status, next_due_at, expires_at, run_count, failures, last_run_at, last_message_id,
  last_outcome, last_output, retry_at, state, event_position, time_created, time_updated`

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
      `SELECT ${COLUMNS} FROM automation ${where} ORDER BY time_created ASC, id ASC`,
      params,
    )
  },

  insert: (row: InsertAutomationRow) =>
    sql`INSERT INTO automation (
      id, project_id, session_id, directory, name, trigger, tz, action,
      status, next_due_at, expires_at, run_count, failures, event_position,
      time_created, time_updated
    ) VALUES (
      ${row.id},
      ${row.projectId},
      ${row.sessionId},
      ${row.directory},
      ${row.name},
      ${JSON.stringify(row.trigger)},
      ${row.tz},
      ${JSON.stringify(row.action)},
      'active',
      ${row.nextDueAt},
      ${row.expiresAt},
      0,
      0,
      ${row.eventPosition === null ? null : JSON.stringify(row.eventPosition)},
      ${row.timeCreated},
      ${row.timeUpdated}
    )`.pipe(Effect.asVoid),

  settle: (row: Pick<AutomationRow, "id" | "runCount">, patch: SettlePatch, options?: SettleOptions) => {
    const sets: Array<string> = []
    const params: Array<string | number | null> = []

    if (patch.status !== undefined) {
      sets.push("status = ?")
      params.push(patch.status)
    }

    if (patch.nextDueAt !== undefined) {
      sets.push("next_due_at = ?")
      params.push(patch.nextDueAt)
    }

    if (patch.runCount !== undefined) {
      sets.push("run_count = ?")
      params.push(patch.runCount)
    }

    if (patch.failures !== undefined) {
      sets.push("failures = ?")
      params.push(patch.failures)
    }

    if (patch.lastRunAt !== undefined) {
      sets.push("last_run_at = ?")
      params.push(patch.lastRunAt)
    }

    if (patch.lastMessageId !== undefined) {
      sets.push("last_message_id = ?")
      params.push(patch.lastMessageId)
    }

    if (patch.lastOutcome !== undefined) {
      sets.push("last_outcome = ?")
      params.push(patch.lastOutcome)
    }

    if (patch.lastOutput !== undefined) {
      sets.push("last_output = ?")
      params.push(patch.lastOutput)
    }

    if (patch.retryAt !== undefined) {
      sets.push("retry_at = ?")
      params.push(patch.retryAt)
    }

    if (patch.state !== undefined) {
      sets.push("state = ?")
      params.push(patch.state === null ? null : JSON.stringify(patch.state))
    }

    if (patch.eventPosition !== undefined) {
      sets.push("event_position = ?")
      params.push(patch.eventPosition === null ? null : JSON.stringify(patch.eventPosition))
    }

    if (patch.timeUpdated !== undefined) {
      sets.push("time_updated = ?")
      params.push(patch.timeUpdated)
    }

    if (sets.length === 0) return Effect.void

    const statusGuard = options?.evenIfPaused ? "status <> 'done'" : "status = 'active'"
    params.push(row.id, row.runCount)

    return sql
      .unsafe(`UPDATE automation SET ${sets.join(", ")} WHERE id = ? AND run_count = ? AND ${statusGuard}`, params)
      .pipe(Effect.asVoid)
  },

  pause: (id: string, now: number) =>
    sql`UPDATE automation SET status = 'paused', time_updated = ${now} WHERE id = ${id} AND status = 'active'`.pipe(
      Effect.asVoid,
    ),

  resume: (id: string, patch: ResumePatch) =>
    sql`UPDATE automation
      SET status = ${patch.status},
          next_due_at = ${patch.nextDueAt},
          failures = 0,
          retry_at = NULL,
          time_updated = ${patch.timeUpdated}
      WHERE id = ${id} AND status = 'paused'`.pipe(Effect.asVoid),

  remove: (id: string) => sql`DELETE FROM automation WHERE id = ${id}`.pipe(Effect.asVoid),

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
      `SELECT ${COLUMNS} FROM automation WHERE status = 'active' AND next_due_at IS NULL ORDER BY time_created ASC, id ASC`,
    ),

  hasPendingInboxMessage: (sessionId: string, requestId: string) =>
    sql<{ found: number }>`SELECT 1 AS found FROM inbox
      WHERE recipient_session_id = ${sessionId} AND request_id = ${requestId} AND status = 'pending'
      LIMIT 1`.pipe(Effect.map((rows) => rows.length > 0)),
})
