// Project store contracts (SPEC §5.4).
import { Schema } from "effect"

export const ProjectKind = Schema.Literals(["docs", "memory", "scratch"])
export type ProjectKind = typeof ProjectKind.Type

export const ProjectEntry = Schema.Struct({
  path: Schema.String,
  size: Schema.Number,
  mtime: Schema.String,
  version: Schema.String,
  description: Schema.String,
})
export type ProjectEntry = typeof ProjectEntry.Type

export const ProjectInfoResult = Schema.Struct({
  instructions: Schema.String,
  docs: Schema.Array(ProjectEntry),
  memory: Schema.Array(ProjectEntry),
  scratch: Schema.Array(ProjectEntry),
  scratchPath: Schema.String,
})
export const ProjectListInput = Schema.Struct({ kind: ProjectKind })
export const ProjectReadInput = Schema.Struct({ kind: ProjectKind, path: Schema.String })
export const ProjectReadResult = Schema.Struct({ content: Schema.String, version: Schema.String })
export const ProjectSearchInput = Schema.Struct({ query: Schema.String, kind: Schema.optional(ProjectKind) })
export const ProjectWriteInput = Schema.Struct({
  kind: ProjectKind,
  path: Schema.String,
  content: Schema.String,
  ifVersion: Schema.String,
})
export const ProjectWriteResult = Schema.Struct({ version: Schema.String })
export const ProjectDeleteInput = Schema.Struct({ kind: ProjectKind, path: Schema.String, ifVersion: Schema.String })

/** `ifVersion` does not match the entry on disk (or "new" for an existing entry, or a version for a missing one). */
export class ProjectConflict extends Schema.TaggedError<ProjectConflict>()("ProjectConflict", {
  message: Schema.String,
}) {}
/** Bad path, too large, looks like a secret, or the entry does not exist. */
export class ProjectInvalid extends Schema.TaggedError<ProjectInvalid>()("ProjectInvalid", {
  message: Schema.String,
}) {}
