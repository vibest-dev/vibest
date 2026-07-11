import { Context, Effect, Layer } from "effect";
import { simpleGit } from "simple-git";

import { GitError } from "../errors.js";

export interface GitStatus {
  readonly current: string | null;
  readonly staged: ReadonlyArray<string>;
  readonly notAdded: ReadonlyArray<string>;
  readonly modified: ReadonlyArray<string>;
  readonly created: ReadonlyArray<string>;
  readonly deleted: ReadonlyArray<string>;
}

export interface GitBranchInfo {
  readonly current: string;
  readonly all: ReadonlyArray<string>;
}

/**
 * `git` module — read-only, delegating to the `git` CLI via simple-git. Method
 * names track the CLI subcommands; only `status`/`branch` are exposed for now
 * (design §4.5 / §8).
 */
export class GitService extends Context.Service<
  GitService,
  {
    readonly status: (dir: string) => Effect.Effect<GitStatus, GitError>;
    readonly branch: (dir: string) => Effect.Effect<GitBranchInfo, GitError>;
  }
>()("GitService") {}

export const GitServiceLayer: Layer.Layer<GitService> = Layer.sync(GitService, () => ({
  status: (dir) =>
    Effect.tryPromise({
      try: async () => {
        const s = await simpleGit(dir).status();
        return {
          current: s.current,
          staged: s.staged,
          notAdded: s.not_added,
          modified: s.modified,
          created: s.created,
          deleted: s.deleted,
        } satisfies GitStatus;
      },
      catch: (cause) => new GitError({ cause }),
    }),

  branch: (dir) =>
    Effect.tryPromise({
      try: async () => {
        const b = await simpleGit(dir).branch();
        return { current: b.current, all: b.all } satisfies GitBranchInfo;
      },
      catch: (cause) => new GitError({ cause }),
    }),
}));
