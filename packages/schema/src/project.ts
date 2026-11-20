import { Schema } from "effect"

import { MachineIncompatible, MachineUnavailable, UnknownMachine } from "./machine.ts"
import { NoSuchSession } from "./session.ts"

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

export class ProjectCloneFailed extends Schema.TaggedError<ProjectCloneFailed>()("ProjectCloneFailed", {
  message: Schema.String,
}) {}

export const CloneFailed = Schema.Union([
  ProjectCloneFailed,
  NoSuchSession,
  UnknownMachine,
  MachineUnavailable,
  MachineIncompatible,
])

export const CloneRequest = {
  url: Schema.String,
  directory: Schema.optional(Schema.String),
  machine: Schema.optional(Schema.String),
}

export const CloneStep = Schema.Union([
  Schema.Struct({ progress: Schema.String }),
  Schema.Struct({ projectId: Schema.String, directory: Schema.String }),
])

export class ProjectCreateFailed extends Schema.TaggedError<ProjectCreateFailed>()("ProjectCreateFailed", {
  message: Schema.String,
}) {}
