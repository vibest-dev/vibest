import os from "node:os";
import path from "node:path";

import { Effect, FileSystem } from "effect";

import { findExecutable, isExecutableFile } from "../executable";

/**
 * Where the native installer puts `grok`. Availability searches these in
 * addition to PATH because a desktop host's GUI PATH is often bare; spawn
 * uses the resolved absolute path, so the two cannot drift.
 */
function extraInstallDirs(home: string): string[] {
  return [path.join(home, ".grok", "bin"), path.join(home, ".local", "bin")];
}

export type ResolveGrokDeps = {
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
};

/**
 * The `grok` binary this adapter should exec, or `undefined` when it is not
 * installed. `VIBEST_GROK_EXECUTABLE` is an explicit override (tests, a
 * relocated install) and is taken as-is when it is executable.
 */
export const resolveGrokExecutable = (
  deps: ResolveGrokDeps = {},
): Effect.Effect<string | undefined, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const { env = process.env, home = os.homedir(), platform = process.platform } = deps;
    const override = env["VIBEST_GROK_EXECUTABLE"];
    if (override) {
      const fromPath = yield* findExecutable(override, { env, platform });
      return fromPath;
    }

    const fromPath = yield* findExecutable("grok", { env, platform });
    if (fromPath) return fromPath;

    const fs = yield* FileSystem.FileSystem;
    const binary = platform === "win32" ? "grok.exe" : "grok";
    for (const dir of extraInstallDirs(home)) {
      const candidate = path.join(dir, binary);
      if (yield* isExecutableFile(fs, candidate, platform)) return candidate;
    }
    return undefined;
  });

export const checkGrokAvailability = (
  deps: ResolveGrokDeps = {},
): Effect.Effect<
  { readonly available: true } | { readonly available: false; readonly reason: string },
  never,
  FileSystem.FileSystem
> =>
  resolveGrokExecutable(deps).pipe(
    Effect.map((found) =>
      found
        ? { available: true as const }
        : {
            available: false as const,
            reason:
              "Grok was not found. Install it from https://x.ai/cli, or set VIBEST_GROK_EXECUTABLE to the path of the `grok` binary.",
          },
    ),
  );
