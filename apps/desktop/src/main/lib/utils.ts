import childProcess from "node:child_process";
import path from "node:path";

import { Effect } from "effect";
import { app } from "electron";

/** Path under the OS temp dir, prefixed `vibest-desktop-`, for throwaway data. */
export function vibestTempPath(name: string): string {
  return path.join(app.getPath("temp"), `vibest-desktop-${name}`);
}

/**
 * userData dir for a dev checkout. Lives in `Vibest Dev/<worktree>`, a sibling
 * of the packaged app's userData dir (`Vibest`) — not the generic `desktop` dir
 * the dev app name would otherwise produce, and separate from prod so the two
 * don't share a single-instance lock. `slug` is the git worktree name; outside a
 * checkout it falls back to a shared `default` dir.
 */
export function devUserDataPath(slug: string | undefined): string {
  return path.join(app.getPath("appData"), "Vibest Dev", slug ?? "default");
}

/**
 * Basename of the current git worktree, sanitized for a path segment (e.g.
 * `dapper-mochi`). Used to key each dev checkout's userData dir. Not
 * `basename(cwd)` — dev's cwd is `apps/desktop`, identical across worktrees.
 * Succeeds with undefined outside a git checkout. Synchronous (childProcess.execFileSync) so
 * it can run in the pre-`whenReady` bootstrap, before any runtime exists.
 */
export const devWorktreeSlug: Effect.Effect<string | undefined> = Effect.try(() =>
  childProcess
    .execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
    .trim(),
).pipe(
  Effect.map((top) => {
    const slug = path.basename(top).replace(/[^a-zA-Z0-9._-]/g, "-");
    return slug.length > 0 ? slug : undefined;
  }),
  Effect.catch(() => Effect.succeed(undefined)),
);
