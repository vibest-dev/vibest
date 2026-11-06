import { Schema } from "effect"

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
