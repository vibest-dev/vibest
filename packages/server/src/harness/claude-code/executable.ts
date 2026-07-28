import { createRequire } from "node:module";
import { homedir } from "node:os";

import { Data, Effect, FileSystem, Path } from "effect";

const moduleRequire = createRequire(import.meta.url);

/** No `claude` binary anywhere we look — carries the user-facing remedy. */
export class ClaudeExecutableNotFound extends Data.TaggedError("ClaudeExecutableNotFound")<{
  readonly reason: string;
}> {
  override get message() {
    return this.reason;
  }
}

const NOT_FOUND =
  "Claude Code was not found. Install it from https://claude.com/claude-code, " +
  "or set VIBEST_CLAUDE_EXECUTABLE to the path of the `claude` binary.";

/** Where the native installer and the common package managers put `claude`. */
function extraInstallDirs(path: Path.Path, home: string): string[] {
  return [
    path.join(home, ".local", "bin"),
    path.join(home, ".bun", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
}

/**
 * The version-matched binary the Claude Agent SDK ships as an optional platform
 * dependency. Present when running from a checkout; absent in the packaged
 * desktop app, which excludes it (it is ~230 MB — the user's own Claude Code
 * install is used there instead).
 *
 * `createRequire` has no Effect equivalent, so module resolution stays raw.
 *
 * A path inside an asar archive is rejected: it resolves and stats fine, since
 * Electron's fs shim reads archives transparently — but an OS exec cannot
 * traverse one, and the SDK would fail late with a bare ENOTDIR.
 */
function sdkBinary(path: Path.Path, binary: string): string | undefined {
  const pkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  try {
    const resolved = moduleRequire.resolve(`${pkg}/${binary}`);
    return resolved.includes(`.asar${path.sep}`) ? undefined : resolved;
  } catch {
    return undefined;
  }
}

export type ResolveDeps = {
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** The SDK's own bundled binary, if it is really on disk. */
  bundled?: (path: Path.Path, binary: string) => string | undefined;
  platform?: NodeJS.Platform;
};

/** PATH's separator. `effect/Path` exposes `sep`, but not this one. */
const pathDelimiter = (platform: NodeJS.Platform) => (platform === "win32" ? ";" : ":");

/**
 * Executability by mode bits — see the note on the shared `findExecutable`:
 * `effect/FileSystem.access` has no `X_OK`.
 */
const isExecutableFile = (
  fs: FileSystem.FileSystem,
  candidate: string,
  platform: NodeJS.Platform,
): Effect.Effect<boolean> =>
  fs.stat(candidate).pipe(
    Effect.map(
      (info) => info.type === "File" && (platform === "win32" || (info.mode & 0o111) !== 0),
    ),
    Effect.catch(() => Effect.succeed(false)),
  );

/**
 * The `claude` binary the SDK should exec.
 *
 * Prefers the SDK's own copy when it is really on disk, because its version is
 * matched to the SDK's wire protocol. Falls back to the user's install — the
 * only option in the packaged app, which is why the desktop host has to hand
 * the server a login-shell PATH: launchd gives a GUI app a bare one.
 */
export const resolveClaudeExecutable = (
  deps: ResolveDeps = {},
): Effect.Effect<string, ClaudeExecutableNotFound, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const {
      env = process.env,
      home = homedir(),
      bundled = sdkBinary,
      platform = process.platform,
    } = deps;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const isExecutable = (candidate: string) => isExecutableFile(fs, candidate, platform);

    const override =
      env["VIBEST_E2E"] === "1"
        ? env["VIBEST_E2E_CLAUDE_EXECUTABLE"]
        : env["VIBEST_CLAUDE_EXECUTABLE"];
    if (override) return override;

    const binary = platform === "win32" ? "claude.exe" : "claude";

    const fromSdk = bundled(path, binary);
    if (fromSdk && (yield* isExecutable(fromSdk))) return fromSdk;

    const dirs = [
      ...(env["PATH"] ?? "").split(pathDelimiter(platform)),
      ...extraInstallDirs(path, home),
    ];
    for (const dir of dirs) {
      if (!dir) continue;
      const candidate = path.join(dir, binary);
      if (yield* isExecutable(candidate)) return candidate;
    }

    return yield* Effect.fail(new ClaudeExecutableNotFound({ reason: NOT_FOUND }));
  });
