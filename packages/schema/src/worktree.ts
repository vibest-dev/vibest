import { Schema } from "effect"

export const RepositoryState = Schema.Literals(["clean", "dirty", "unsaved", "unknown"])

export type RepositoryState = typeof RepositoryState.Type

export const WorktreeRepository = Schema.Struct({
  folder: Schema.String,
  branch: Schema.optional(Schema.String),
  commit: Schema.optional(Schema.String),
  state: RepositoryState,
  changed: Schema.optional(Schema.Number),
})

export type WorktreeRepository = typeof WorktreeRepository.Type

export const WorktreeSession = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  state: Schema.Literals(["live", "archived"]),
})

export type WorktreeSession = typeof WorktreeSession.Type

export const WorktreeInfo = Schema.Struct({
  path: Schema.String,
  repositories: Schema.Array(WorktreeRepository),
  sessions: Schema.Array(WorktreeSession),
})

export type WorktreeInfo = typeof WorktreeInfo.Type

export const WorktreeProject = Schema.Struct({
  id: Schema.String,
  directory: Schema.String,
  worktrees: Schema.Array(WorktreeInfo),
})

export type WorktreeProject = typeof WorktreeProject.Type

export const WorktreeList = Schema.Struct({
  projects: Schema.Array(WorktreeProject),
})

export type WorktreeList = typeof WorktreeList.Type
