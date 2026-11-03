// The workspace port: where a project's code lives and where each session works. The engine asks it about directories
// and to make or take away a session's own workspace; it never runs git itself. The product layer gives the one
// implementation (@vibest/vibest/workspace: git checkouts and detached worktrees).
import { NotInRepository } from "@vibest/schema/session"
import { Context, type Effect, type PlatformError, Schema } from "effect"

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
  /** The project's name for people: origin's repository name, else the main checkout's directory name. */
  readonly name: (directory: string) => Effect.Effect<string, NotInRepository | GitError | PlatformError.PlatformError>
  /** Whether a session's workspace may not be made under `directory` (it is a checkout, or not a directory). */
  readonly parentBlocked: (directory: string) => Effect.Effect<boolean, PlatformError.PlatformError>
  /**
   * A session's own workspace at `path` (which must not exist yet): a detached worktree of `root`, or one per
   * repository of a multi-repository project (with their included files); `discard` takes it away again.
   */
  readonly allocate: (root: string, path: string) => Effect.Effect<void, Failure | CopyFailed>
  /** Undo `allocate` after a start that failed; git without force, so a refusal leaves it for `vibest archive`. */
  readonly discard: (root: string, path: string) => Effect.Effect<void, Failure>
  /** The files a checkout keeps beside git (`.worktreeinclude`) copied into `path`; the names copied. */
  readonly copyIncluded: (root: string, path: string) => Effect.Effect<ReadonlyArray<string>, Failure | CopyFailed>
  /** Git state of a session's workspace; undefined when the path is missing or not a directory. */
  readonly state: (path: string) => Effect.Effect<GitState | undefined, PlatformError.PlatformError>
  /** Git state per repository of a multi-repository workspace; undefined when `path` is not one. */
  readonly repositoryStates: (
    path: string,
  ) => Effect.Effect<ReadonlyArray<RepositoryGit> | undefined, PlatformError.PlatformError>
  /** Whether `path` is a linked worktree of `repository` (its main checkout does not count). */
  readonly isLinked: (repository: string, path: string) => Effect.Effect<boolean>
  /** Remove linked worktree `path` of `repository`, without force: git refuses one with changes. */
  readonly removeLinked: (repository: string, path: string) => Effect.Effect<void, GitError>
}

export class Workspace extends Context.Service<Workspace, WorkspaceShape>()("vibest/Workspace") {}
