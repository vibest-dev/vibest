import fs from "node:fs/promises";

import type { GitBranch } from "@vibest/contract/git";
import { Context, Effect, Layer } from "effect";
import { type BranchSummary, simpleGit, type StatusResult } from "simple-git";

import { GitError, GitNotRepository, WorkspaceNotDirectory, WorkspaceReadError } from "../errors";

const isNotRepositoryMessage = (cause: unknown): boolean => {
  const message = cause instanceof Error ? cause.message : String(cause);
  return /not a git repository/i.test(message);
};

const probeWorkspace = (cwd: string) =>
  Effect.tryPromise({
    try: () => fs.stat(cwd),
    catch: (cause) => new WorkspaceReadError({ path: cwd, cause }),
  }).pipe(
    Effect.flatMap((info) =>
      info.isDirectory() ? Effect.void : Effect.fail(new WorkspaceNotDirectory({ path: cwd })),
    ),
  );

/**
 * `git` module — read-only, delegating to the `git` CLI via simple-git.
 * `status` returns simple-git's `StatusResult`. `branch` classifies workspace
 * availability so a missing `.git` is data, not an RPC error.
 */
export class GitService extends Context.Service<
  GitService,
  {
    readonly status: (dir: string) => Effect.Effect<StatusResult, GitError>;
    readonly branch: (dir: string) => Effect.Effect<GitBranch, GitError>;
  }
>()("GitService") {}

export const GitServiceLayer: Layer.Layer<GitService> = Layer.sync(GitService, () => ({
  status: (dir) =>
    Effect.tryPromise({
      try: () => simpleGit(dir).status(),
      catch: (cause) => new GitError({ cause }),
    }),

  branch: (cwd) =>
    probeWorkspace(cwd).pipe(
      Effect.andThen(
        Effect.tryPromise({
          try: () => simpleGit(cwd).branch(),
          catch: (cause) =>
            isNotRepositoryMessage(cause) ? new GitNotRepository({ cwd }) : new GitError({ cause }),
        }),
      ),
      Effect.map(
        (summary: BranchSummary): GitBranch => ({
          kind: "repository",
          current: summary.current ?? null,
        }),
      ),
      Effect.catchTags({
        GitNotRepository: () => Effect.succeed({ kind: "not-repository" as const }),
        WorkspaceNotDirectory: () => Effect.succeed({ kind: "workspace-unavailable" as const }),
        WorkspaceReadError: () => Effect.succeed({ kind: "workspace-unavailable" as const }),
      }),
    ),
}));
