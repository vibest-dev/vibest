import { Effect, Schema } from "effect"
import type { SqlClient } from "effect/sql"

const Ended = Schema.Struct({ reason: Schema.String })

const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Ended))

export const migration = {
  id: "20261120000000_limited_end_is_exited",
  up: (tx: SqlClient.SqlClient) =>
    Effect.gen(function* () {
      const rows = yield* tx<{ position: number; data: string }>`SELECT position, data FROM event
        WHERE type = 'process.ended' ORDER BY position`

      for (const row of rows) {
        if ((yield* decode(row.data).pipe(Effect.orDie)).reason !== "limited") continue
        yield* tx`UPDATE event SET data = json_patch(data, ${JSON.stringify({ reason: "exited" })})
          WHERE position = ${row.position}`
      }
    }),
}
