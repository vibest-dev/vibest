// Project folder contracts (SPEC §5.4): agents read and write the folder with their own file tools.
import { Schema } from "effect"

/** The fixed subfolders of a project folder (`projects/<project id>/`). */
export const ProjectKind = Schema.Literals(["docs", "memories", "artifacts"])
export type ProjectKind = typeof ProjectKind.Type

/** Absolute paths: the project folder, its instructions.md and its subfolders. */
export const ProjectInfoResult = Schema.Struct({
  directory: Schema.String,
  instructions: Schema.String,
  docs: Schema.String,
  memories: Schema.String,
  artifacts: Schema.String,
})
export const ProjectSearchInput = Schema.Struct({ query: Schema.String, kind: Schema.optional(ProjectKind) })
