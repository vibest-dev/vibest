import os from "node:os";
import path from "node:path";

import { Effect, FileSystem } from "effect";

/**
 * The mechanics of locating a CLI on disk. *Where to look, in what order* is
 * each harness's own business — see `<agent>/executable.ts`; this file only
 * supplies the two things all three would otherwise reimplement: "is this a
 * runnable file" and "walk the install directories for this name".
 *
 * The whole point of resolving here rather than letting the OS do it: the
 * result is an absolute path, and **that path is what gets spawned**. It used
 * to be PATH-only, deliberately — the transports spawned a bare command name,
 * the OS resolved that through PATH alone, so anything found elsewhere would
 * have reported a harness available that then failed with an opaque ENOENT.
 *
 * So the invariant every caller inherits: *never widen the search without the
 * result reaching spawn.* Resolve here and then exec a bare name and you have
 * reintroduced the exact bug this replaced — availability answered off one set
 * of rules, the launch off another.
 *
 * The old shape cost real users: a `codex` installed by bun (`~/.bun/bin`, not
 * on a systemd unit's PATH) read as "not installed", while claude-code — whose
 * resolver already searched past PATH *because* its result was passed to the
 * SDK — found its own binary in that very directory.
 */

/**
 * Windows resolves a bare name through PATHEXT, and npm-installed CLIs land as
 * `.cmd` shims rather than `.exe` — checking only `.exe` would report every one
 * of them missing.
 */
const WINDOWS_EXTENSIONS = [".com", ".exe", ".bat", ".cmd"];

/** PATH's separator — `node:path.delimiter` is fixed to the host platform. */
export const pathDelimiter = (platform: NodeJS.Platform) => (platform === "win32" ? ";" : ":");

/**
 * Where the native installers and common package managers put a CLI. Searched
 * after PATH, so a PATH entry always wins; this exists for the process whose
 * PATH is not a login shell's — a systemd unit, a launchd GUI app, a
 * non-interactive `ssh host "…"` — which is the normal case for a server
 * deployment and the one where every one of these directories is missing.
 */
function fallbackInstallDirs(home: string): ReadonlyArray<string> {
  return [
    path.join(home, ".local", "bin"),
    path.join(home, ".bun", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
}

export type ResolveExecutableDeps = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
};

/**
 * Is this path a runnable file? `effect/FileSystem.access` has no `X_OK`, so
 * executability is read off the mode bits instead of asked of the kernel: this
 * accepts a binary only the owner may run, where `access(X_OK)` would have
 * rejected it for everyone else. The consequence is an EACCES at spawn time
 * rather than an up-front "not found" — rare for a CLI installed on PATH.
 * Windows has no execute bit at all, so there existence is the whole test —
 * which is also all `access(X_OK)` ever checked there.
 */
export const isExecutableFile = (
  fs: FileSystem.FileSystem,
  candidate: string,
  platform: NodeJS.Platform,
): Effect.Effect<boolean> =>
  fs.stat(candidate).pipe(
    Effect.map(
      (info) => info.type === "File" && (platform === "win32" || (info.mode & 0o111) !== 0),
    ),
    // A candidate that cannot be stat'd (absent, unreadable dir) is not here.
    Effect.catch(() => Effect.succeed(false)),
  );

/**
 * The names a bare command can take on this platform. Exported because a
 * harness that nominates a file itself — a copy inside its own package — has to
 * ask for the same set of names the search would have tried.
 */
export const candidateNames = (
  binaryName: string,
  platform: NodeJS.Platform,
): ReadonlyArray<string> =>
  platform !== "win32" || path.extname(binaryName)
    ? [binaryName]
    : WINDOWS_EXTENSIONS.map((extension) => `${binaryName}${extension}`);

/**
 * A single candidate, checked. For the levels a harness knows how to name
 * itself — an env override it wants verified, a copy inside its own package.
 */
export const executableAt = (
  candidate: string,
  deps: ResolveExecutableDeps = {},
): Effect.Effect<string | undefined, never, FileSystem.FileSystem> =>
  FileSystem.FileSystem.use((fs) =>
    isExecutableFile(fs, candidate, deps.platform ?? process.platform),
  ).pipe(Effect.map((runnable) => (runnable ? candidate : undefined)));

/**
 * Walk PATH, then the fallback install directories, for `binaryName`. One walk
 * so PATH order is honoured and a PATH hit always beats a fallback; candidates
 * are checked in sequence and the first runnable one wins, rather than stat'ing
 * the whole search space.
 *
 * `undefined` means "not installed anywhere we look" — the caller decides
 * whether that is the end of its search and what to say about it.
 */
export const searchInstallDirs = (
  binaryName: string,
  deps: ResolveExecutableDeps = {},
): Effect.Effect<string | undefined, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const { env = process.env, platform = process.platform, home = os.homedir() } = deps;
    const fs = yield* FileSystem.FileSystem;

    const directories = [
      ...(env["PATH"] ?? "").split(pathDelimiter(platform)),
      ...fallbackInstallDirs(home),
    ];
    for (const directory of directories) {
      if (!directory) continue;
      for (const name of candidateNames(binaryName, platform)) {
        const candidate = path.join(directory, name);
        if (yield* isExecutableFile(fs, candidate, platform)) return candidate;
      }
    }
    return undefined;
  });
