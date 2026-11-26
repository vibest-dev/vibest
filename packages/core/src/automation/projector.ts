import { AutomationEvent } from "@vibest/schema/automation-event"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"

import { Bus } from "../bus.ts"

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const sql = yield* SqlClient.SqlClient

    yield* bus.project(
      AutomationEvent.Created,
      (event) =>
        sql`INSERT INTO automation (
        id, name, project_id, session_id, directory, trigger_json, tz, action_json,
        status, next_due_at, expires_at, run_count, failures,
        last_run_at, last_outcome, last_output, retry_at, state_json,
        event_cursor, last_event_id, has_cursor, created_at, updated_at
      ) VALUES (
        ${event.data.automationId},
        ${event.data.name},
        ${event.data.projectId},
        ${event.data.sessionId ?? null},
        ${event.data.directory},
        ${JSON.stringify(event.data.trigger)},
        ${event.data.tz},
        ${JSON.stringify(event.data.action)},
        'active',
        ${event.data.nextDueAt ?? null},
        ${event.data.expiresAt ?? null},
        0,
        0,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        0,
        ${event.created},
        ${event.created}
      )`,
    )

    yield* bus.project(
      AutomationEvent.Paused,
      (event) =>
        sql`UPDATE automation SET
        status = 'paused',
        retry_at = NULL,
        last_outcome = COALESCE(${event.data.lastOutcome ?? null}, last_outcome),
        last_output = COALESCE(${event.data.reason ?? null}, last_output),
        last_run_at = COALESCE(${event.data.lastRunAt ?? null}, last_run_at),
        failures = COALESCE(${event.data.failures ?? null}, failures),
        updated_at = ${event.created}
      WHERE id = ${event.data.automationId}`,
    )

    yield* bus.project(
      AutomationEvent.Resumed,
      (event) =>
        sql`UPDATE automation SET
        status = 'active',
        failures = 0,
        retry_at = NULL,
        next_due_at = ${event.data.nextDueAt ?? null},
        updated_at = ${event.created}
      WHERE id = ${event.data.automationId}`,
    )

    yield* bus.project(AutomationEvent.Removed, (event) =>
      Effect.andThen(
        sql`DELETE FROM automation_dedup WHERE automation_id = ${event.data.automationId}`,
        sql`DELETE FROM automation WHERE id = ${event.data.automationId}`,
      ),
    )

    yield* bus.project(AutomationEvent.Triggered, (event) =>
      Effect.gen(function* () {
        const hasState = "state" in event.data && event.data.state !== undefined
        const hasNextDue = "nextDueAt" in event.data
        const hasRetry = "retryAt" in event.data
        const hasOutput = "lastOutput" in event.data
        const hasCursor = "cursor" in event.data

        yield* sql`UPDATE automation SET
          status = ${event.data.status},
          run_count = ${event.data.runCount},
          failures = ${event.data.failures},
          next_due_at = CASE WHEN ${hasNextDue ? 1 : 0} = 1 THEN ${event.data.nextDueAt ?? null} ELSE next_due_at END,
          retry_at = CASE WHEN ${hasRetry ? 1 : 0} = 1 THEN ${event.data.retryAt ?? null} ELSE retry_at END,
          last_run_at = COALESCE(${event.data.lastRunAt ?? null}, last_run_at),
          last_outcome = ${event.data.lastOutcome},
          last_output = CASE WHEN ${hasOutput ? 1 : 0} = 1 THEN ${event.data.lastOutput ?? null} ELSE last_output END,
          state_json = CASE WHEN ${hasState ? 1 : 0} = 1 THEN ${hasState ? JSON.stringify(event.data.state) : null} ELSE state_json END,
          event_cursor = CASE WHEN ${hasCursor ? 1 : 0} = 1 THEN ${event.data.cursor ?? null} ELSE event_cursor END,
          last_event_id = COALESCE(${event.data.lastEventId ?? null}, last_event_id),
          has_cursor = CASE WHEN ${hasCursor ? 1 : 0} = 1 THEN 1 ELSE has_cursor END,
          updated_at = ${event.created}
        WHERE id = ${event.data.automationId}`

        if (event.data.dedupKey !== undefined) {
          yield* sql`INSERT OR IGNORE INTO automation_dedup (automation_id, dedup_key, created_at)
            VALUES (${event.data.automationId}, ${event.data.dedupKey}, ${event.created})`
        }
      }),
    )

    yield* bus.project(
      AutomationEvent.CursorSaved,
      (event) =>
        sql`UPDATE automation SET
        event_cursor = ${event.data.cursor},
        last_event_id = COALESCE(${event.data.lastEventId ?? null}, last_event_id),
        has_cursor = 1,
        updated_at = ${event.created}
      WHERE id = ${event.data.automationId}`,
    )
  }),
)
