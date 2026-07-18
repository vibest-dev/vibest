import { execFileSync } from "node:child_process";
import path from "node:path";

import { app } from "electron";

/** Path under the OS temp dir, prefixed `vibest-desktop-`, for throwaway data. */
export function vibestTempPath(name: string): string {
  return path.join(app.getPath("temp"), `vibest-desktop-${name}`);
}

/**
 * Basename of the current git worktree, sanitized for a path segment (e.g.
 * `dapper-mochi`). Used to key each dev checkout's userData dir. Not
 * `basename(cwd)` — dev's cwd is `apps/desktop`, identical across worktrees.
 * Undefined outside a git checkout.
 */
export function devWorktreeSlug(): string | undefined {
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const slug = path.basename(top).replace(/[^a-zA-Z0-9._-]/g, "-");
    return slug.length > 0 ? slug : undefined;
  } catch {
    return undefined;
  }
}
