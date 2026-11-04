// The workspace port: where a project's code lives and where each session works. The engine asks it about directories
// and to make or take away a session's own workspace; it never runs git itself. The product layer gives the one
// implementation (@vibest/vibest/workspace: git checkouts and detached worktrees).
import { NotInRepository } from "@vibest/schema/session"
import { Context, type Effect, type PlatformError, Schema, type Scope } from "effect"

export { NotInRepository }

export class GitError extends Schema.TaggedError<GitError>()("GitError", {
  args: Schema.Array(Schema.String),
  message: Schema.String,
}) {}

export class CopyFailed extends Schema.TaggedError<CopyFailed>()("CopyFailed", {
  source: Schema.String,
  destination: Schema.String,
  message: Schema.String,
}) {}

export interface GitState {
  readonly branch: string
  readonly pushed: boolean
  /** Removing the worktree would lose nothing. */
  readonly saved: boolean
  readonly why: string
}

/** A direct child of a multi-repository project: its own git checkout. */
export interface ProjectRepository {
  readonly name: string
  readonly path: string
  /** Current branch; empty when HEAD is detached. */
  readonly branch: string
}

export interface RepositoryGit extends GitState {
  readonly name: string
}

type Failure = GitError | PlatformError.PlatformError

/** The product refused to name a new session's workspace (an unsafe repository name, a blocked parent, no free name). */
export class WorkspaceRefused extends Schema.TaggedError<WorkspaceRefused>()("WorkspaceRefused", {
  message: Schema.String,
}) {}

/** What `release` decides about a session's workspace once its terminal is closed. */
export interface Released {
  /** `gone`: it was already missing. */
  readonly worktree: "removed" | "kept" | "gone"
  /** Why it stays (or that it was already gone). */
  readonly reason?: string | undefined
  /** It stays because another live session works in it. */
  readonly shared: boolean
  /** Its branch (one `name=branch` line per repository of a multi-repository workspace), or null. */
  readonly branch: string | null
}

export interface WorkspaceShape {
  /** The project `directory` is in: its root and its key. */
  readonly project: (
    directory: string,
  ) => Effect.Effect<{ readonly root: string; readonly key: string }, NotInRepository | PlatformError.PlatformError>
  /** The repositories of a multi-repository project at `directory`; undefined when it is one repository (or none). */
  readonly repositories: (
    directory: string,
  ) => Effect.Effect<ReadonlyArray<ProjectRepository> | undefined, PlatformError.PlatformError>
  /** The main checkout of the repository `directory` is in (a linked worktree's is its main checkout). */
  readonly mainCheckout: (directory: string) => Effect.Effect<string, NotInRepository | GitError>
  /** A new session's workspace directory for the project at `root`, reserved (made, empty) so no other session gets it. */
  readonly reserve: (root: string) => Effect.Effect<string, WorkspaceRefused>
  /**
   * The session's workspace at `path` made ready for its harness: made in the directory `reserve` gave (unless `shared`:
   * it works in another session's) with the files a checkout keeps beside git. Undone when the scope closes failed.
   */
  readonly prepare: (
    root: string,
    path: string,
    shared: boolean,
  ) => Effect.Effect<void, Failure | CopyFailed, Scope.Scope>
  /** Git state of a session's workspace; undefined when the path is missing or not a directory. */
  readonly state: (path: string) => Effect.Effect<GitState | undefined, PlatformError.PlatformError>
  /** Git state per repository of a multi-repository workspace; undefined when `path` is not one. */
  readonly repositoryStates: (
    path: string,
  ) => Effect.Effect<ReadonlyArray<RepositoryGit> | undefined, PlatformError.PlatformError>
  /**
   * Take away session `id`'s workspace at `path` once its terminal is closed, only when nothing can be lost (the
   * product's checks: it made it, no live sharer, git loses nothing). `processes`: whether the engine proved no process
   * works in it any more; `liveSharers` is read again just before anything is removed.
   */
  readonly release: (input: {
    readonly id: string
    readonly path: string
    readonly keep: boolean
    readonly processes: { readonly state: "exited" | "alive" | "unknown"; readonly why: string }
    readonly liveSharers: Effect.Effect<ReadonlyArray<string>>
  }) => Effect.Effect<Released, PlatformError.PlatformError>
}

export class Workspace extends Context.Service<Workspace, WorkspaceShape>()("vibest/Workspace") {}
