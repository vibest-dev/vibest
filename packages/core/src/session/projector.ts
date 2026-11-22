import {
  ExecutionAccepted,
  ExecutionAllocated,
  ExecutionFailed,
  ExecutionInput,
  ExecutionInterrupted,
  ExecutionStarted,
  ExecutionSucceeded,
  ExecutionUnresolved,
  type Fact,
  InboxDelivered,
  InboxDeliveryFailed,
  InboxDeliveryStarted,
  InboxDropped,
  InboxEnqueued,
  InboxUnresolved,
  ProcessConversation,
  ProcessEnded,
  ProcessPid,
  ProcessPlaced,
  ProcessReady,
  ProcessStarted,
  SessionCreated,
  SessionDirectoryChanged,
  SessionEnded,
  SessionRenamed,
} from "@vibest/schema/event"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"

import { Bus, type Definition, type Projector } from "../bus.ts"
import { senderColumns, senderKey } from "../database/db-rows.ts"

const sessionIdOf = (fact: Fact) => fact.sessionId!

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const sql = yield* SqlClient.SqlClient

    const active =
      <D extends Definition>(projector: Projector<D>): Projector<D> =>
      (fact) =>
        Effect.andThen(
          projector(fact),
          sql`UPDATE session SET active_at = max(coalesce(active_at, 0), ${fact.at}) WHERE id = ${sessionIdOf(fact)}`,
        )

    yield* bus.project(SessionCreated, (fact) => {
      const { data } = fact
      const origin = data.origin

      return sql`INSERT INTO session (id, project_id, parent_session_id, agent, name, directory, origin_peer,
          origin_project, origin_session, team, created_at, active_at, message_id)
        VALUES (${sessionIdOf(fact)}, ${data.project}, ${data.parent ?? null}, ${data.agent}, ${data.name},
          ${data.directory}, ${origin?.peer ?? null}, ${origin?.project ?? null}, ${origin?.session ?? null},
          ${data.team ?? null}, ${fact.at}, ${origin === undefined ? null : fact.at}, ${data.message ?? null})`
    })
    yield* bus.project(
      SessionRenamed,
      (fact) => sql`UPDATE session SET name = ${fact.data.name} WHERE id = ${sessionIdOf(fact)}`,
    )
    yield* bus.project(
      SessionDirectoryChanged,
      (fact) => sql`UPDATE session SET directory = ${fact.data.directory} WHERE id = ${sessionIdOf(fact)}`,
    )
    yield* bus.project(SessionEnded, (fact) =>
      Effect.andThen(
        sql`UPDATE session SET ended_at = coalesce(ended_at, ${fact.at}) WHERE id = ${sessionIdOf(fact)}`,
        sql`UPDATE outbox SET peer_id = '' WHERE session_id = ${sessionIdOf(fact)} AND acked_at IS NULL`,
      ),
    )

    yield* bus.project(
      ProcessStarted,
      active((fact) => {
        const { data } = fact

        return Effect.andThen(
          sql`INSERT INTO process (id, session_id, harness, provider, model, routing, harness_session_id, runtime, terminal,
              pid, started_at, placed_at)
            VALUES (${fact.seq}, ${sessionIdOf(fact)}, ${data.harness}, ${data.provider ?? null}, ${data.model ?? null},
              ${data.routing === undefined ? null : JSON.stringify(data.routing)}, ${data.resume ?? null}, ${data.runtime},
              ${data.terminal ?? null}, ${data.pid ?? null}, ${fact.at}, ${data.terminal === undefined ? null : fact.at})`,
          sql`UPDATE session SET process_id = ${fact.seq} WHERE id = ${sessionIdOf(fact)}`,
        )
      }),
    )
    yield* bus.project(
      ProcessPlaced,
      active(
        (fact) =>
          sql`UPDATE process SET terminal = ${fact.data.terminal}, placed_at = ${fact.at},
              pid = coalesce(${fact.data.pid ?? null}, pid)
            WHERE session_id = ${sessionIdOf(fact)} AND id = ${fact.data.process}`,
      ),
    )
    yield* bus.project(
      ProcessReady,
      active((fact) => {
        const { integration } = fact.data

        return sql`UPDATE process SET ready_at = ${fact.at}, pid = coalesce(${fact.data.pid ?? null}, pid),
            integration_version = ${integration === undefined ? sql`integration_version` : integration.version},
            integration_protocol = ${integration === undefined ? sql`integration_protocol` : integration.protocol}
          WHERE session_id = ${sessionIdOf(fact)} AND id = ${fact.data.process}`
      }),
    )
    yield* bus.project(
      ProcessPid,
      active(
        (fact) =>
          sql`UPDATE process SET pid = ${fact.data.pid} WHERE session_id = ${sessionIdOf(fact)} AND id = ${fact.data.process}`,
      ),
    )
    yield* bus.project(
      ProcessConversation,
      active(
        (fact) =>
          sql`UPDATE process SET harness_session_id = ${fact.data.conversation}
            WHERE session_id = ${sessionIdOf(fact)} AND id = ${fact.data.process}`,
      ),
    )
    yield* bus.project(
      ProcessEnded,
      active((fact) =>
        Effect.gen(function* () {
          const { process, reason } = fact.data
          const session = sessionIdOf(fact)
          yield* sql`UPDATE process SET ended_at = ${fact.at}, end_reason = ${reason}
            WHERE session_id = ${session} AND id = ${process} AND ended_at IS NULL`

          if (reason !== "launch_failed") return
          yield* sql`UPDATE session SET process_id = coalesce((SELECT max(id) FROM process WHERE session_id = ${session}
              AND NOT (terminal IS NULL AND end_reason = 'launch_failed')), process_id)
            WHERE id = ${session}
              AND EXISTS (SELECT 1 FROM process WHERE session_id = ${session} AND id = ${process} AND terminal IS NULL)`
        }),
      ),
    )

    const openEnded = (session: string, execution: number) =>
      sql`session_id = ${session} AND id = ${execution} AND (outcome IS NULL OR outcome IN ('lost', 'not_started'))`

    yield* bus.project(
      ExecutionAllocated,
      active((fact) =>
        Effect.gen(function* () {
          const session = sessionIdOf(fact)
          yield* sql`INSERT INTO execution (session_id, id, process_id, typed, booked_at, owner)
              VALUES (${session}, ${fact.data.executionId}, ${fact.data.processId ?? null},
                ${fact.data.typed ?? null}, ${fact.at}, 0)`
          yield* sql`UPDATE execution SET owner = 1 WHERE session_id = ${session} AND id = ${fact.data.executionId}
              AND NOT EXISTS (SELECT 1 FROM execution WHERE session_id = ${session} AND owner = 1)`
        }),
      ),
    )
    yield* bus.project(ExecutionAccepted, () => Effect.void)
    yield* bus.project(
      ExecutionStarted,
      active((fact) =>
        Effect.gen(function* () {
          const session = sessionIdOf(fact)
          const id = fact.data.executionId
          yield* sql`UPDATE execution SET owner = 0 WHERE session_id = ${session} AND id != ${id}
              AND EXISTS (SELECT 1 FROM execution WHERE session_id = ${session} AND id = ${id} AND started_at IS NULL)`
          yield* sql`UPDATE execution SET started_at = coalesce(started_at, ${fact.at}), owner = 1,
                process_id = coalesce(${fact.data.processId ?? null}, process_id)
              WHERE session_id = ${session} AND id = ${id} AND started_at IS NULL`
        }),
      ),
    )
    yield* bus.project(
      ExecutionSucceeded,
      active(
        (fact) =>
          sql`UPDATE execution SET outcome = 'completed', reply = ${fact.data.reply ?? null}, ended_at = ${fact.at}, owner = 0,
              failure = null, failure_kind = null
            WHERE ${openEnded(sessionIdOf(fact), fact.data.executionId)}`,
      ),
    )
    yield* bus.project(
      ExecutionFailed,
      active(
        (fact) =>
          sql`UPDATE execution SET outcome = 'failed', reply = ${fact.data.reply ?? null},
              failure = ${fact.data.failure.message}, failure_kind = ${fact.data.failure.kind ?? null},
              ended_at = ${fact.at}, owner = 0
            WHERE ${openEnded(sessionIdOf(fact), fact.data.executionId)}`,
      ),
    )
    yield* bus.project(
      ExecutionInterrupted,
      active(
        (fact) =>
          sql`UPDATE execution SET outcome = 'interrupted', reply = ${fact.data.reply ?? null}, ended_at = ${fact.at},
              owner = 0, failure = null, failure_kind = null
            WHERE ${openEnded(sessionIdOf(fact), fact.data.executionId)}`,
      ),
    )
    yield* bus.project(
      ExecutionUnresolved,
      active(
        (fact) =>
          sql`UPDATE execution SET outcome = ${fact.data.observation}, owner = 0,
              reply = ${fact.data.reply ?? null},
              failure = ${fact.data.failure?.message ?? null}, failure_kind = ${fact.data.failure?.kind ?? null}
            WHERE session_id = ${sessionIdOf(fact)} AND id = ${fact.data.executionId} AND outcome IS NULL`,
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
      ExecutionInput,
      active(
        (fact) =>
          sql`UPDATE execution SET typed = CASE WHEN typed IS NULL THEN ${fact.data.typed}
              ELSE typed || char(10) || ${fact.data.typed} END
            WHERE session_id = ${sessionIdOf(fact)} AND id = ${fact.data.executionId}`,
      ),
    )
    yield* bus.project(
      InboxEnqueued,
      active((fact) => inboxRow(sessionIdOf(fact), fact.seq, { ...fact.data, status: "pending" })),
    )
    yield* bus.project(
      InboxDeliveryStarted,
      active(
        (fact) =>
          sql`UPDATE inbox SET status = 'delivering',
              recipient_execution_id = coalesce(${fact.data.execution ?? null}, recipient_execution_id)
            WHERE recipient_session_id = ${sessionIdOf(fact)} AND id = ${fact.data.messageId}`,
      ),
    )
    yield* bus.project(
      InboxDelivered,
      active(
        (fact) =>
          sql`UPDATE inbox SET status = 'delivered', recipient_execution_id = ${fact.data.recipientExecutionId}
            WHERE recipient_session_id = ${sessionIdOf(fact)} AND id = ${fact.data.messageId}`,
      ),
    )
    yield* bus.project(
      InboxDeliveryFailed,
      active(
        (fact) =>
          sql`UPDATE inbox SET status = 'failed'
            WHERE recipient_session_id = ${sessionIdOf(fact)} AND id = ${fact.data.messageId}`,
      ),
    )
    yield* bus.project(
      InboxDropped,
      active(
        (fact) =>
          sql`UPDATE inbox SET status = 'dropped'
            WHERE recipient_session_id = ${sessionIdOf(fact)} AND id = ${fact.data.messageId}`,
      ),
    )
    yield* bus.project(
      InboxUnresolved,
      active((fact) => {
        const { data } = fact
        const sender = data.sender
        const content = data.content

        if (data.history === "released" && data.messageId !== undefined)
          return sql`UPDATE inbox SET status = 'pending', recipient_execution_id = NULL
            WHERE recipient_session_id = ${sessionIdOf(fact)} AND id = ${data.messageId}`

        if (data.messageId !== undefined || sender === undefined || content === undefined)
          return sql`UPDATE inbox SET status = 'unresolved'
            WHERE recipient_session_id = ${sessionIdOf(fact)} AND id = ${data.messageId ?? fact.seq}`

        return inboxRow(sessionIdOf(fact), fact.seq, {
          sender,
          content,
          status: "unresolved",
          ...(data.senderExecutionId !== undefined && { senderExecutionId: data.senderExecutionId }),
          ...(data.requestId !== undefined && { requestId: data.requestId }),
          ...(data.transferId !== undefined && { transferId: data.transferId }),
          ...(data.aboutSessionId !== undefined && { aboutSessionId: data.aboutSessionId }),
        })
      }),
    )
  }),
)
