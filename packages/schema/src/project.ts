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
