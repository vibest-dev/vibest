// What `vibest archive` reports.
import { Schema } from "effect"

/**
 * What `vibest rm` did, layer by layer; `reasons` says why anything was kept. The branch is always kept. `processes`: whether
 * the processes herdr reported in the session's pane are gone (`exited`), not all gone yet (`alive`), or vibest cannot tell
 * (`unknown`: no record of them, or signal 0 could not answer).
 */
export const RemoveOutcome = Schema.Struct({
  id: Schema.String,
  processes: Schema.Literals(["exited", "alive", "unknown"]),
  pane: Schema.Literals(["closed", "kept", "none"]),
  workspace: Schema.Literals(["closed", "kept", "none"]),
  worktree: Schema.Literals(["removed", "kept", "gone"]),
  path: Schema.String,
  branch: Schema.NullOr(Schema.String),
  reasons: Schema.Array(Schema.String),
})
export type RemoveOutcome = typeof RemoveOutcome.Type
