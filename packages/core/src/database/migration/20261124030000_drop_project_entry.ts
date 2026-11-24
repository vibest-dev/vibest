import { Effect, Schema } from "effect"
import type { SqlClient } from "effect/sql"

const Ended = Schema.Struct({
  reason: Schema.String,
})

const decodeEnded = (data: string) => Schema.decodeUnknownEffect(Schema.fromJsonString(Ended))(data).pipe(Effect.orDie)

export const migration = {
  id: "20261124030000_drop_project_entry",
  up: (tx: SqlClient.SqlClient) =>
    Effect.gen(function* () {
      const ended = yield* tx<{ readonly position: number; readonly data: string }>`SELECT position, data FROM event
        WHERE type = 'session.ended' ORDER BY position`

      for (const row of ended) {
        const parsed = yield* decodeEnded(row.data)

        if (parsed.reason === "replaced") {
          yield* tx`UPDATE event SET data = ${JSON.stringify({ reason: "archived" })} WHERE position = ${row.position}`
        }
      }

      const affected = yield* tx<{ readonly aggregate: string }>`SELECT DISTINCT aggregate FROM event
        WHERE type = 'project.entry_changed'`

      if (affected.length === 0) return

      yield* tx`DELETE FROM event WHERE type = 'project.entry_changed'`

      for (const { aggregate } of affected) {
        const remaining = yield* tx<{ readonly position: number }>`SELECT position FROM event
          WHERE aggregate = ${aggregate} ORDER BY position`

        if (remaining.length === 0) continue

        yield* tx`UPDATE event SET seq = -position WHERE aggregate = ${aggregate}`

        for (let i = 0; i < remaining.length; i++) {
          yield* tx`UPDATE event SET seq = ${i + 1} WHERE position = ${remaining[i]!.position}`
        }
      }
    }),
}
