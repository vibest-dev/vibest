import os from "node:os";
import path from "node:path";

import { Effect, FileSystem } from "effect";

import { findExecutable, isExecutableFile } from "../executable";

/**
 * Where the Cursor CLI installer puts `cursor-agent`. Availability searches
 * these in addition to PATH because a desktop host's GUI PATH is often bare;
 * spawn uses the resolved absolute path, so the two cannot drift.
 *
 * Never fall back to `agent`: Grok's CLI ships an `agent` binary that wins
 * PATH resolution and is the wrong process.
 */
function extraInstallDirs(home: string): string[] {
  return [path.join(home, ".local", "bin"), path.join(home, ".cursor", "bin")];
}

export type ResolveCursorDeps = {
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
};

export const cursorNotFoundMessage =
  "Cursor Agent was not found. Install the Cursor CLI from https://cursor.com/cli, run `agent login`, or set VIBEST_CURSOR_EXECUTABLE to the `cursor-agent` binary.";

/**
 * The `cursor-agent` binary this adapter should exec, or `undefined` when it
 * is not installed. `VIBEST_CURSOR_EXECUTABLE` is an explicit override (tests,
 * a relocated install) and is taken as-is when it is executable.
 */
export const resolveCursorExecutable = (
  deps: ResolveCursorDeps = {},
): Effect.Effect<string | undefined, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const { env = process.env, home = os.homedir(), platform = process.platform } = deps;
    const override = env["VIBEST_CURSOR_EXECUTABLE"];
    if (override) {
      return yield* findExecutable(override, { env, platform });
    }

    const fromPath = yield* findExecutable("cursor-agent", { env, platform });
    if (fromPath) return fromPath;

    const fs = yield* FileSystem.FileSystem;
    const binary = platform === "win32" ? "cursor-agent.exe" : "cursor-agent";
    for (const dir of extraInstallDirs(home)) {
      const candidate = path.join(dir, binary);
      if (yield* isExecutableFile(fs, candidate, platform)) return candidate;
    }
    return undefined;
  });

export const checkCursorAvailability = (
  deps: ResolveCursorDeps = {},
): Effect.Effect<
  { readonly available: true } | { readonly available: false; readonly reason: string },
  never,
  FileSystem.FileSystem
> =>
  resolveCursorExecutable(deps).pipe(
    Effect.map((found) =>
      found
        ? { available: true as const }
        : { available: false as const, reason: cursorNotFoundMessage },
    ),
  );
