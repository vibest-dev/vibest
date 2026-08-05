import os from "node:os";
import path from "node:path";

import type { HarnessAgentId } from "@vibest/contract";
import { Effect, FileSystem } from "effect";

import { ExecutableNotFound } from "./errors";

/**
 * Locating the CLI a harness runs — one search, shared by all three.
 *
 * It used to search PATH and nothing else, deliberately: the transports
 * spawned a bare command name (`spawn("codex")`), the OS resolved that through
 * PATH alone, so anything found elsewhere would have reported a harness
 * available that then failed with an opaque ENOENT. That constraint is gone,
 * and removing it is the point of this module: {@link resolveHarnessExecutable}
 * returns an absolute path and **that path is what gets spawned**. The search
 * and the launch can no longer disagree, because they are the same answer.
 *
 * Which makes the invariant to protect: *never widen this search without the
 * result reaching spawn.* A caller that resolves here and then execs a bare
 * name has reintroduced the exact bug this replaced — the harness reports
 * available off one set of rules and launches off another.
 *
 * The old shape cost real users: a `codex` installed by bun (`~/.bun/bin`, not
 * on a systemd unit's PATH) read as "not installed", while claude-code — whose
 * resolver already searched past PATH *because* its result was passed to the
 * SDK — found its own binary in that very directory.
 *
 * Four levels, first hit wins. What differs per harness is declared in a
 * {@link HarnessExecutableSpec}; the walk itself never varies.
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
 * after PATH, so a PATH entry always wins; this level exists for the process
 * whose PATH is not a login shell's — a systemd unit, a launchd GUI app, a
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

/**
 * What one harness declares about finding its CLI. Everything here is a
 * difference that is real between harnesses; anything the same for all three
 * belongs in {@link resolveHarnessExecutable} instead.
 */
export type HarnessExecutableSpec = {
  readonly harnessAgentId: HarnessAgentId;
  /** Bare name, no extension — Windows variants are derived by the resolver. */
  readonly binaryName: string;
  /**
   * An operator's explicit answer, read straight from the environment. A
   * function rather than a variable name because claude-code has a second,
   * test-only variable gated on `VIBEST_E2E`.
   */
  readonly override: (env: NodeJS.ProcessEnv) => string | undefined;
  /**
   * The copy that ships as one of vibest's own dependencies, resolved through
   * the module graph. Absent for a harness vibest does not bundle (codex).
   * Best-effort by contract: a miss falls through to PATH rather than failing,
   * because the same code runs from a source checkout and from a bundle whose
   * module graph does not contain the harness.
   */
  readonly bundled?: (binary: string) => string | undefined;
  /** Human-facing sentence for `checkAvailability`, naming how to fix it. */
  readonly notFoundReason: string;
};

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

/** The names a bare command can take on this platform. */
const candidateNames = (binaryName: string, platform: NodeJS.Platform): ReadonlyArray<string> =>
  platform !== "win32" || path.extname(binaryName)
    ? [binaryName]
    : WINDOWS_EXTENSIONS.map((extension) => `${binaryName}${extension}`);

/**
 * The absolute path to a harness's CLI, or {@link ExecutableNotFound}.
 *
 * The result is what the transport spawns — see the module note above; that is
 * the whole reason levels 2 and 4 are allowed to exist.
 */
export const resolveHarnessExecutable = (
  spec: HarnessExecutableSpec,
  deps: ResolveExecutableDeps = {},
): Effect.Effect<string, ExecutableNotFound, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const { env = process.env, platform = process.platform, home = os.homedir() } = deps;
    const fs = yield* FileSystem.FileSystem;
    const isExecutable = (candidate: string) => isExecutableFile(fs, candidate, platform);

    // 1. An explicit override is taken at face value, unverified. Falling back
    //    when it does not exist would be worse than failing: the operator
    //    would be told the harness works while it silently runs a different
    //    binary than the one they named.
    const override = spec.override(env);
    if (override) return override;

    const names = candidateNames(spec.binaryName, platform);

    // 2. vibest's own copy, when it has one.
    for (const name of names) {
      const bundled = spec.bundled?.(name);
      if (bundled && (yield* isExecutable(bundled))) return bundled;
    }

    // 3 and 4. PATH first, then the install directories a stripped environment
    //    would have dropped. One walk, so PATH order is honoured and a PATH hit
    //    always beats a fallback.
    const directories = [
      ...(env["PATH"] ?? "").split(pathDelimiter(platform)),
      ...fallbackInstallDirs(home),
    ];
    for (const directory of directories) {
      if (!directory) continue;
      for (const name of names) {
        const candidate = path.join(directory, name);
        if (yield* isExecutable(candidate)) return candidate;
      }
    }

    return yield* Effect.fail(
      new ExecutableNotFound({
        harnessAgentId: spec.harnessAgentId,
        executable: spec.binaryName,
        reason: spec.notFoundReason,
      }),
    );
  });
