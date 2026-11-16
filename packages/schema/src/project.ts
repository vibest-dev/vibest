import { Schema } from "effect"

export const ProjectKind = Schema.Literals(["docs", "memories", "artifacts"])
export type ProjectKind = typeof ProjectKind.Type

export const ProjectInfoResult = Schema.Struct({
  directory: Schema.String,
  preferences: Schema.String,
  docs: Schema.String,
  memories: Schema.String,
  artifacts: Schema.String,
})
export const ProjectSearchInput = Schema.Struct({ query: Schema.String, kind: Schema.optional(ProjectKind) })

export const ProjectActivity = Schema.Literals(["blocked", "done", "working", "idle"])
export type ProjectActivity = typeof ProjectActivity.Type

export class ProjectCreateFailed extends Schema.TaggedError<ProjectCreateFailed>()("ProjectCreateFailed", {
  message: Schema.String,
}) {}
