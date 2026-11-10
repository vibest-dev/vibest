import { Cause, Console, Effect } from "effect"
import { SqlClient } from "effect/sql"

import { MIGRATION_TABLE } from "../../db-schema.ts"
import { importInPlace } from "../../import/import.ts"
import { installLedger } from "../../journal.ts"
import type { Migration } from "../migration.ts"

export const NOT_IMPORTED_TABLE = "v1_event"

export const notImportedLine = (reason: string) =>
  `LedgerNotImported: the history from before this vibest was not imported (${reason}); vibestd started with an empty history and kept the old tables as v1_<name> in the same file`

const reasonOf = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause)
  const message = error instanceof Error ? error.message : String(error)
  return message.split("\n")[0]!
}

const keepAside = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const objects = yield* sql<{ type: string; name: string }>`SELECT type, name FROM sqlite_schema
      WHERE type IN ('index', 'trigger', 'table') AND name NOT LIKE 'sqlite_%' AND name != ${MIGRATION_TABLE}
        AND (type != 'index' OR sql IS NOT NULL)`
    for (const object of objects.filter((o) => o.type !== "table"))
      yield* sql.unsafe(`DROP ${object.type === "index" ? "INDEX" : "TRIGGER"} "${object.name}"`)
    for (const table of objects.filter((o) => o.type === "table"))
      yield* sql.unsafe(`ALTER TABLE "${table.name}" RENAME TO "v1_${table.name}"`)
  })

const migration: Migration = {
  id: "20261110120000_ledger",
  up: (sql) =>
    Effect.gen(function* () {
      const failure = yield* importInPlace.pipe(
        Effect.as(undefined),
        Effect.catchCause((cause) => (Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.succeed(cause))),
      )
      if (failure === undefined) return
      yield* Console.error(Cause.pretty(failure))
      yield* keepAside(sql)
      yield* installLedger
      yield* Console.error(notImportedLine(reasonOf(failure)))
    }).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
}

export default migration
