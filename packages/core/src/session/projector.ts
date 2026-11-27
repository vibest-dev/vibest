import { ProcessEvent } from "@vibest/schema/process-event"
import { SessionEvent } from "@vibest/schema/session-event"
import { canonicalTarget } from "@vibest/schema/terminal"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"

import { Bus, type Definition, type Projector } from "../bus.ts"
import { senderColumns, senderKey } from "../database/rows.ts"

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const sql = yield* SqlClient.SqlClient

    const active =
      <D extends Definition>(projector: Projector<D>): Projector<D> =>
      (event) =>
        Effect.andThen(
          projector(event),
          sql`UPDATE session SET active_at = max(coalesce(active_at, 0), ${event.created})
            WHERE id = ${event.durable.aggregateId}`,
        )

    yield* bus.project(SessionEvent.Created, (event) => {
      const { data } = event
      const origin = data.origin

      return sql`INSERT INTO session (id, project_id, parent_session_id, agent, name, directory, origin_remote,
          origin_project, origin_session, created_at, active_at, message_id)
        VALUES (${data.sessionId}, ${data.project}, ${data.parent ?? null}, ${data.agent}, ${data.name},
          ${data.directory}, ${origin?.remote ?? null}, ${origin?.project ?? null}, ${origin?.session ?? null},
          ${event.created}, ${origin === undefined ? null : event.created}, ${data.messageId ?? null})`
    })
    yield* bus.project(
      SessionEvent.Renamed,
      (event) => sql`UPDATE session SET name = ${event.data.name} WHERE id = ${event.data.sessionId}`,
    )
    yield* bus.project(
      SessionEvent.DirectoryChanged,
      (event) => sql`UPDATE session SET directory = ${event.data.directory} WHERE id = ${event.data.sessionId}`,
    )
    yield* bus.project(SessionEvent.Archived, (event) =>
      Effect.andThen(
        sql`UPDATE session SET ended_at = coalesce(ended_at, ${event.created}) WHERE id = ${event.data.sessionId}`,
        sql`UPDATE outbox SET remote_id = '' WHERE session_id = ${event.data.sessionId} AND acked_at IS NULL`,
      ),
    )
    yield* bus.project(
      SessionEvent.Linked,
      (event) =>
        sql`INSERT OR IGNORE INTO session_edge (from_session_id, to_remote_id, to_session_id)
          VALUES (${event.data.sessionId}, ${event.data.remote ?? ""}, ${event.data.to})`,
    )
    yield* bus.project(
      SessionEvent.Unlinked,
      (event) =>
        sql`DELETE FROM session_edge WHERE from_session_id = ${event.data.sessionId}
          AND to_remote_id = ${event.data.remote ?? ""} AND to_session_id = ${event.data.to}`,
    )

    yield* bus.project(
      ProcessEvent.Started,
      active((event) => {
        const { data } = event

        return Effect.andThen(
          sql`INSERT INTO process (id, session_id, harness, provider, model, routing, harness_session_id, runtime, terminal,
              pid, started_at, placed_at)
            VALUES (${data.processId}, ${data.sessionId}, ${data.harness}, ${data.provider ?? null}, ${data.model ?? null},
              ${data.routing === undefined ? null : JSON.stringify(data.routing)}, ${data.resume ?? null}, ${data.runtime},
              ${data.terminal === undefined ? null : canonicalTarget(data.terminal)}, ${data.pid ?? null}, ${event.created}, ${data.terminal === undefined ? null : event.created})`,
          sql`UPDATE session SET process_id = ${data.processId} WHERE id = ${data.sessionId}`,
        )
      }),
    )
    yield* bus.project(
      ProcessEvent.Updated,
      active((event) => {
        const { data } = event

        return sql`UPDATE process SET terminal = ${data.terminal === undefined ? sql`terminal` : canonicalTarget(data.terminal)},
            placed_at = ${data.terminal === undefined ? sql`placed_at` : sql`coalesce(placed_at, ${event.created})`},
            pid = coalesce(${data.pid ?? null}, pid),
            harness_session_id = coalesce(${data.conversation ?? null}, harness_session_id)
          WHERE session_id = ${data.sessionId} AND id = ${data.processId}`
      }),
    )
    yield* bus.project(
      ProcessEvent.Ready,
      active((event) => {
        const { integration } = event.data

        return sql`UPDATE process SET ready_at = ${event.created}, pid = coalesce(${event.data.pid ?? null}, pid),
            integration_version = ${integration === undefined ? sql`integration_version` : integration.version},
            integration_protocol = ${integration === undefined ? sql`integration_protocol` : integration.protocol}
          WHERE session_id = ${event.data.sessionId} AND id = ${event.data.processId}`
      }),
    )
    yield* bus.project(
      ProcessEvent.Ended,
      active((event) =>
        Effect.gen(function* () {
          const { processId, reason, sessionId } = event.data
          yield* sql`UPDATE process SET ended_at = ${event.created}, end_reason = ${reason}
            WHERE session_id = ${sessionId} AND id = ${processId} AND ended_at IS NULL`

          if (reason !== "launch_failed") return
          yield* sql`UPDATE session SET process_id = coalesce((SELECT max(id) FROM process WHERE session_id = ${sessionId}
              AND NOT (terminal IS NULL AND end_reason = 'launch_failed')), process_id)
            WHERE id = ${sessionId}
              AND EXISTS (SELECT 1 FROM process WHERE session_id = ${sessionId} AND id = ${processId} AND terminal IS NULL)`
        }),
      ),
    )

    const openEnded = (session: string, execution: number) =>
      sql`session_id = ${session} AND id = ${execution} AND (outcome IS NULL OR outcome IN ('lost', 'not_started'))`

    yield* bus.project(
      SessionEvent.ExecutionAllocated,
      active((event) =>
        Effect.gen(function* () {
          const session = event.data.sessionId
          yield* sql`INSERT INTO execution (session_id, id, process_id, typed, booked_at, owner)
              VALUES (${session}, ${event.data.executionId}, ${event.data.processId ?? null},
                ${event.data.typed ?? null}, ${event.created}, 0)`
          yield* sql`UPDATE execution SET owner = 1 WHERE session_id = ${session} AND id = ${event.data.executionId}
              AND NOT EXISTS (SELECT 1 FROM execution WHERE session_id = ${session} AND owner = 1)`
        }),
      ),
    )
    yield* bus.project(
      SessionEvent.ExecutionStarted,
      active((event) =>
        Effect.gen(function* () {
          const session = event.data.sessionId
          const id = event.data.executionId
          yield* sql`UPDATE execution SET owner = 0 WHERE session_id = ${session} AND id != ${id}
              AND EXISTS (SELECT 1 FROM execution WHERE session_id = ${session} AND id = ${id} AND started_at IS NULL)`
          yield* sql`UPDATE execution SET started_at = coalesce(started_at, ${event.created}), owner = 1,
                process_id = coalesce(${event.data.processId ?? null}, process_id)
              WHERE session_id = ${session} AND id = ${id} AND started_at IS NULL`
        }),
      ),
    )
    yield* bus.project(
      SessionEvent.ExecutionSucceeded,
      active(
        (event) =>
          sql`UPDATE execution SET outcome = 'completed', reply = ${event.data.reply ?? null}, ended_at = ${event.created}, owner = 0,
              failure = null, failure_kind = null
            WHERE ${openEnded(event.data.sessionId, event.data.executionId)}`,
      ),
    )
    yield* bus.project(
      SessionEvent.ExecutionFailed,
      active(
        (event) =>
          sql`UPDATE execution SET outcome = 'failed', reply = ${event.data.reply ?? null},
              failure = ${event.data.failure.message}, failure_kind = ${event.data.failure.kind ?? null},
              ended_at = ${event.created}, owner = 0
            WHERE ${openEnded(event.data.sessionId, event.data.executionId)}`,
      ),
    )
    yield* bus.project(
      SessionEvent.ExecutionInterrupted,
      active(
        (event) =>
          sql`UPDATE execution SET outcome = 'interrupted', reply = ${event.data.reply ?? null}, ended_at = ${event.created},
              owner = 0, failure = null, failure_kind = null
            WHERE ${openEnded(event.data.sessionId, event.data.executionId)}`,
      ),
    )
    yield* bus.project(
      SessionEvent.ExecutionUnresolved,
      active(
        (event) =>
          sql`UPDATE execution SET outcome = ${event.data.observation}, owner = 0,
              reply = ${event.data.reply ?? null},
              failure = ${event.data.failure?.message ?? null}, failure_kind = ${event.data.failure?.kind ?? null}
            WHERE session_id = ${event.data.sessionId} AND id = ${event.data.executionId} AND outcome IS NULL`,
      ),
    )

    const inboxRow = (
      session: string,
      id: number,
      row: {
        readonly sender: Parameters<typeof senderColumns>[0]
        readonly content: string
        readonly status: string
        readonly senderExecutionId?: number | undefined
        readonly requestId?: string | undefined
        readonly transferId?: string | undefined
        readonly aboutSessionId?: string | undefined
      },
    ) => {
      const sender = senderColumns(row.sender)

      return sql`INSERT INTO inbox (recipient_session_id, id, sender_type, sender_session_id, sender_agent, sender_title,
          sender_machine, sender_plugin, sender_key, about_session_id, content, request_id, transfer_id, status,
          sender_execution_id)
        VALUES (${session}, ${id}, ${sender.type}, ${sender.session}, ${sender.agent}, ${sender.title},
          ${sender.machine}, ${sender.plugin}, ${senderKey(row.sender)}, ${row.aboutSessionId ?? null}, ${row.content},
          ${row.requestId ?? null}, ${row.transferId ?? null}, ${row.status}, ${row.senderExecutionId ?? null})`
    }

    yield* bus.project(
      SessionEvent.ExecutionInput,
      active(
        (event) =>
          sql`UPDATE execution SET typed = CASE WHEN typed IS NULL THEN ${event.data.typed}
              ELSE typed || char(10) || ${event.data.typed} END
            WHERE session_id = ${event.data.sessionId} AND id = ${event.data.executionId}`,
      ),
    )
    yield* bus.project(
      SessionEvent.InboxEnqueued,
      active((event) => inboxRow(event.data.sessionId, event.data.messageId, { ...event.data, status: "pending" })),
    )
    yield* bus.project(
      SessionEvent.InboxDelivering,
      active(
        (event) =>
          sql`UPDATE inbox SET status = 'delivering',
              recipient_execution_id = coalesce(${event.data.execution ?? null}, recipient_execution_id)
            WHERE recipient_session_id = ${event.data.sessionId} AND id = ${event.data.messageId}`,
      ),
    )
    yield* bus.project(
      SessionEvent.InboxDelivered,
      active(
        (event) =>
          sql`UPDATE inbox SET status = 'delivered', recipient_execution_id = ${event.data.recipientExecutionId}
            WHERE recipient_session_id = ${event.data.sessionId} AND id = ${event.data.messageId}`,
      ),
    )
    yield* bus.project(
      SessionEvent.InboxFailed,
      active(
        (event) =>
          sql`UPDATE inbox SET status = 'failed'
            WHERE recipient_session_id = ${event.data.sessionId} AND id = ${event.data.messageId}`,
      ),
    )
    yield* bus.project(
      SessionEvent.InboxDropped,
      active(
        (event) =>
          sql`UPDATE inbox SET status = 'dropped'
            WHERE recipient_session_id = ${event.data.sessionId} AND id = ${event.data.messageId}`,
      ),
    )
  }),
)
