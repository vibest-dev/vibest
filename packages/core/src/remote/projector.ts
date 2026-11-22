import {
  MachineAdded,
  MachineConnected,
  MachineRemoved,
  OutboxAcked,
  OutboxQueued,
  PeerSeen,
} from "@vibest/schema/event"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"

import { Bus } from "../bus.ts"
import { countSent } from "../session/projector.ts"

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const sql = yield* SqlClient.SqlClient
    yield* bus.project(
      MachineAdded,
      (fact) =>
        sql`INSERT INTO machine (name, target, vibestd_id, connected_at, created_at)
          VALUES (${fact.data.name}, ${fact.data.target}, ${fact.data.vibestd}, ${fact.at}, ${fact.at})`,
    )
    yield* bus.project(
      MachineConnected,
      (fact) => sql`UPDATE machine SET connected_at = ${fact.at} WHERE name = ${fact.data.name}`,
    )
    yield* bus.project(MachineRemoved, (fact) => sql`DELETE FROM machine WHERE name = ${fact.data.name}`)
    yield* bus.project(
      PeerSeen,
      (fact) =>
        sql`INSERT INTO peer (id, name, connected_at)
          VALUES (${fact.data.id}, ${fact.data.name}, ${fact.at})
          ON CONFLICT (id) DO UPDATE SET name = excluded.name, connected_at = excluded.connected_at`,
    )
    yield* bus.project(OutboxQueued, (fact) =>
      sql`INSERT INTO outbox (id, seq, peer_id, session_id, recipient, kind, content, from_session, from_agent,
            from_title, from_machine, execution_id, created_at)
          VALUES (${fact.data.id}, ${fact.seq}, ${fact.data.peer}, ${fact.data.session}, ${fact.data.recipient ?? null},
            ${fact.data.kind ?? "notice"}, ${fact.data.content}, ${fact.data.from?.session ?? null},
            ${fact.data.from?.agent ?? null}, ${fact.data.from?.title ?? null}, ${fact.data.from?.machine ?? null},
            ${fact.data.execution ?? null}, ${fact.at})`.pipe(
        Effect.andThen(countSent(sql, fact.data.session, fact.data.kind ?? "notice", fact.data.execution)),
      ),
    )
    yield* bus.project(
      OutboxAcked,
      (fact) =>
        sql`UPDATE outbox SET acked_at = ${fact.at}
          WHERE peer_id = ${fact.data.peer} AND acked_at IS NULL AND ${sql.in("id", fact.data.ids)}`,
    )
  }),
)
