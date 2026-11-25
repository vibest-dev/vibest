import { MachineEvent } from "@vibest/schema/machine-event"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"

import { Bus } from "../bus.ts"

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const sql = yield* SqlClient.SqlClient
    yield* bus.project(
      MachineEvent.Added,
      (event) =>
        sql`INSERT INTO machine (name, target, remote_id, connected_at, created_at)
          VALUES (${event.data.name}, ${event.data.target}, ${event.data.remote}, ${event.created}, ${event.created})`,
    )
    yield* bus.project(
      MachineEvent.Connected,
      (event) => sql`UPDATE machine SET connected_at = ${event.created} WHERE name = ${event.data.name}`,
    )
    yield* bus.project(MachineEvent.Removed, (event) => sql`DELETE FROM machine WHERE name = ${event.data.name}`)
    yield* bus.project(
      MachineEvent.RemoteSeen,
      (event) =>
        sql`INSERT INTO remote (id, name, connected_at)
          VALUES (${event.data.remoteId}, ${event.data.name}, ${event.created})
          ON CONFLICT (id) DO UPDATE SET name = excluded.name, connected_at = excluded.connected_at`,
    )
    yield* bus.project(
      MachineEvent.OutboxQueued,
      (event) =>
        sql`INSERT INTO outbox (id, seq, remote_id, session_id, recipient, kind, content, from_session, from_agent,
            from_title, from_machine, execution_id, created_at)
          VALUES (${event.data.id}, ${event.durable.seq}, ${event.data.remoteId}, ${event.data.session}, ${event.data.recipient ?? null},
            ${event.data.kind ?? "notice"}, ${event.data.content}, ${event.data.from?.session ?? null},
            ${event.data.from?.agent ?? null}, ${event.data.from?.title ?? null}, ${event.data.from?.machine ?? null},
            ${event.data.execution ?? null}, ${event.created})`,
    )
    yield* bus.project(
      MachineEvent.OutboxAcked,
      (event) =>
        sql`UPDATE outbox SET acked_at = ${event.created}
          WHERE remote_id = ${event.data.remoteId} AND acked_at IS NULL AND ${sql.in("id", event.data.ids)}`,
    )
  }),
)
