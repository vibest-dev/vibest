import { Effect } from "effect"

import type { Migration } from "../migration.ts"
import { AUTOMATION_MIGRATION_ID, AUTOMATION_SCHEMA } from "../schema.sql.ts"

export const automationMigration: Migration = {
  id: AUTOMATION_MIGRATION_ID,
  up: (tx) =>
    Effect.forEach(AUTOMATION_SCHEMA, (statement) => tx.unsafe(statement), {
      discard: true,
    }),
}
