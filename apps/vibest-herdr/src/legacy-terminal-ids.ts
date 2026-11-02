// One-off migration owned by the herdr product (runtime-port.md §2): rows from before the runtime port stored the
// herdr runtime's own `{type, session, pane}` in `session.runtime`; core decodes only `{kind, machine, id}` and calls
// the id opaque, so the old shape is rewritten here, once at daemon start, before core ever reads the table. A row
// without a pane becomes id "" — core's "no terminal". Safe to repeat: rewritten rows no longer match.
import type { SqlClient } from "effect/sql"
import { Effect } from "effect"

type LegacyRow = { readonly id: string; readonly runtime: string }

export const migrateLegacyTerminalIds = (sql: SqlClient.SqlClient): Effect.Effect<void> =>
  Effect.gen(function* () {
    const rows = (yield* sql`SELECT id, runtime FROM session WHERE runtime IS NOT NULL AND runtime LIKE '%"type"%'`) as unknown as ReadonlyArray<LegacyRow>
    for (const row of rows) {
      const next = rewrite(row.runtime, row.id)
      if (next === undefined) continue
      yield* sql`UPDATE session SET runtime = ${next} WHERE id = ${row.id} AND runtime = ${row.runtime}`
    }
  }).pipe(Effect.catch(() => Effect.void))

/** `{type, session, pane?}` → `{kind, machine, id}`; the id carries the agent name those builds gave it (`s-<row id>`),
 * so the runtime still finds a live agent by its own name. undefined when the row is not one of those. */
export const rewrite = (raw: string, id: string): string | undefined => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== "object" || parsed === null) return undefined
  const value = parsed as { readonly type?: unknown; readonly session?: unknown; readonly pane?: unknown }
  if (typeof value.type !== "string" || value.type === "" || typeof value.session !== "string") return undefined
  if (value.pane !== undefined && typeof value.pane !== "string") return undefined
  return JSON.stringify({ kind: value.type, machine: "local", id: value.pane === undefined ? "" : `${value.session}/${value.pane}/s-${id}` })
}
