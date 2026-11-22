import {
  ExecutionAccepted,
  ExecutionEnded,
  ExecutionStarted,
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
import { localSessionOf, senderColumns, senderKey } from "../database/db-rows.ts"

const sessionIdOf = (fact: Fact) => fact.sessionId!

export const countSent = (
  sql: SqlClient.SqlClient,
  session: string | undefined,
  kind: string,
  execution: number | undefined,
) =>
  session === undefined || kind !== "send" || execution === undefined
    ? Effect.void
    : sql`UPDATE execution SET sent = sent + 1 WHERE session_id = ${session} AND id = ${execution}`

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
          origin_project, origin_session, created_at, active_at, message_id)
        VALUES (${sessionIdOf(fact)}, ${data.project}, ${data.parent ?? null}, ${data.agent}, ${data.name},
          ${data.directory}, ${origin?.peer ?? null}, ${origin?.project ?? null}, ${origin?.session ?? null}, ${fact.at},
          ${origin === undefined ? null : fact.at}, ${data.message ?? null})`
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
        sql`DELETE FROM outbox WHERE session_id = ${sessionIdOf(fact)} AND acked_at IS NULL`,
      ),
    )

    yield* bus.project(
      ProcessStarted,
      active((fact) => {
        const { data } = fact

        return Effect.andThen(
          sql`INSERT INTO process (id, session_id, harness, provider, model, routing, conversation, runtime, terminal,
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
          sql`UPDATE process SET conversation = ${fact.data.conversation}
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

    yield* bus.project(
      ExecutionStarted,
      active(
        (fact) =>
          sql`INSERT INTO execution (session_id, id, process_id, typed, started_at)
            VALUES (${sessionIdOf(fact)}, ${fact.seq}, ${fact.data.process ?? null}, ${fact.data.typed ?? null},
              ${fact.at})`,
      ),
    )
    yield* bus.project(
      ExecutionAccepted,
      active(
        (fact) =>
          sql`UPDATE execution SET accepted_at = ${fact.at}
            WHERE session_id = ${sessionIdOf(fact)} AND id = ${fact.data.execution} AND outcome IS NULL
              AND accepted_at IS NULL`,
      ),
    )
    yield* bus.project(
      ExecutionEnded,
      active((fact) =>
        Effect.andThen(
          sql`UPDATE execution SET outcome = ${fact.data.outcome}, reply = ${fact.data.reply ?? null},
              failure = ${fact.data.failure?.message ?? null}, failure_kind = ${fact.data.failure?.kind ?? null},
              ended_at = ${fact.at}
            WHERE session_id = ${sessionIdOf(fact)} AND id = ${fact.data.execution} AND outcome IS NULL`,
          fact.data.conversation === undefined
            ? Effect.void
            : sql`UPDATE process SET conversation = ${fact.data.conversation}
                WHERE session_id = ${sessionIdOf(fact)}
                  AND id = (SELECT process_id FROM session WHERE id = ${sessionIdOf(fact)})`,
        ),
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

      return Effect.gen(function* () {
        yield* sql`INSERT INTO inbox (session_id, id, sender_type, sender_session_id, sender_agent, sender_title,
          sender_machine, sender_plugin, sender_key, about_session_id, content, request, transfer_id, status,
          sender_execution_id)
        VALUES (${session}, ${id}, ${sender.type}, ${sender.session}, ${sender.agent}, ${sender.title},
          ${sender.machine}, ${sender.plugin}, ${senderKey(row.sender)}, ${row.aboutSessionId ?? null}, ${row.content},
          ${row.requestId ?? null}, ${row.transferId ?? null}, ${row.status}, ${row.senderExecutionId ?? null})`
        yield* countSent(sql, localSessionOf(row.sender), "send", row.senderExecutionId)
      })
    }

    yield* bus.project(
      InboxEnqueued,
      active((fact) => inboxRow(sessionIdOf(fact), fact.seq, { ...fact.data, status: "pending" })),
    )
    yield* bus.project(
      InboxDeliveryStarted,
      active(
        (fact) =>
          sql`UPDATE inbox SET status = 'delivering'
            WHERE session_id = ${sessionIdOf(fact)} AND id = ${fact.data.messageId}`,
      ),
    )
    yield* bus.project(
      InboxDelivered,
      active(
        (fact) =>
          sql`UPDATE inbox SET status = 'delivered', recipient_execution_id = ${fact.data.recipientExecutionId}
            WHERE session_id = ${sessionIdOf(fact)} AND id = ${fact.data.messageId}`,
      ),
    )
    yield* bus.project(
      InboxDeliveryFailed,
      active(
        (fact) =>
          sql`UPDATE inbox SET status = 'failed'
            WHERE session_id = ${sessionIdOf(fact)} AND id = ${fact.data.messageId}`,
      ),
    )
    yield* bus.project(
      InboxDropped,
      active(
        (fact) =>
          sql`UPDATE inbox SET status = 'dropped'
            WHERE session_id = ${sessionIdOf(fact)} AND id = ${fact.data.messageId}`,
      ),
    )
    yield* bus.project(
      InboxUnresolved,
      active((fact) => {
        const { data } = fact
        const sender = data.sender
        const content = data.content

        if (data.messageId !== undefined || sender === undefined || content === undefined)
          return sql`UPDATE inbox SET status = 'unresolved'
            WHERE session_id = ${sessionIdOf(fact)} AND id = ${data.messageId ?? fact.seq}`

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
