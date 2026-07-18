import { execFileSync } from "node:child_process";
import path from "node:path";

import { Effect } from "effect";
import { app } from "electron";

/** Path under the OS temp dir, prefixed `vibest-desktop-`, for throwaway data. */
export function vibestTempPath(name: string): string {
  return path.join(app.getPath("temp"), `vibest-desktop-${name}`);
}

/**
 * Basename of the current git worktree, sanitized for a path segment (e.g.
 * `dapper-mochi`). Used to key each dev checkout's userData dir. Not
 * `basename(cwd)` — dev's cwd is `apps/desktop`, identical across worktrees.
 * Succeeds with undefined outside a git checkout. Synchronous (execFileSync) so
 * it can run in the pre-`whenReady` bootstrap, before any runtime exists.
 */
export const devWorktreeSlug: Effect.Effect<string | undefined> = Effect.try(() =>
  execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim(),
).pipe(
  Effect.map((top) => {
    const slug = path.basename(top).replace(/[^a-zA-Z0-9._-]/g, "-");
    return slug.length > 0 ? slug : undefined;
  }),
  Effect.catch(() => Effect.succeed(undefined)),
);
