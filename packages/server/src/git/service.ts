import { Context, Effect, Layer } from "effect";
import { type BranchSummary, simpleGit, type StatusResult } from "simple-git";

import { GitError } from "../errors";

/**
 * `git` module — read-only, delegating to the `git` CLI via simple-git. Returns
 * simple-git's own result types (`StatusResult`, `BranchSummary`) rather than
 * re-modelling them. Only `status`/`branch` are exposed for now (design §4.5 /
 * §8).
 */
export class GitService extends Context.Service<
  GitService,
  {
    readonly status: (dir: string) => Effect.Effect<StatusResult, GitError>;
    readonly branch: (dir: string) => Effect.Effect<BranchSummary, GitError>;
  }
>()("GitService") {}

export const GitServiceLayer: Layer.Layer<GitService> = Layer.sync(GitService, () => ({
  status: (dir) =>
    Effect.tryPromise({
      try: () => simpleGit(dir).status(),
      catch: (cause) => new GitError({ cause }),
    }),

  branch: (dir) =>
    Effect.tryPromise({
      try: () => simpleGit(dir).branch(),
      catch: (cause) => new GitError({ cause }),
    }),
}));
