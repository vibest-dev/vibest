import { Schema } from "effect"

import { MachineName } from "./id.ts"

export const ArchivedBranch = Schema.Struct({
  repository: Schema.NonEmptyString,
  branch: Schema.NonEmptyString,
})

export type ArchivedBranch = typeof ArchivedBranch.Type

export const ArchiveOutcome = Schema.Struct({
  id: Schema.String,
  machine: Schema.optional(MachineName),
  processes: Schema.Literals(["exited", "alive", "unknown"]),
  pane: Schema.Literals(["closed", "kept", "none"]),
  workspace: Schema.Literals(["closed", "kept", "none"]),
  worktree: Schema.Literals(["removed", "kept", "gone"]),
  path: Schema.String,
  branches: Schema.Array(ArchivedBranch),
  reasons: Schema.Array(Schema.String),
})

export type ArchiveOutcome = typeof ArchiveOutcome.Type
