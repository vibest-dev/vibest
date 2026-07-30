import childProcess from "node:child_process";
import module from "node:module";
import os from "node:os";
import path from "node:path";
import util from "node:util";

import { Data, Effect, FileSystem } from "effect";

import { isExecutableFile, pathDelimiter } from "../executable";

const moduleRequire = module.createRequire(import.meta.url);
const execFileAsync = util.promisify(childProcess.execFile);

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
function extraInstallDirs(home: string): string[] {
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
 * `module.createRequire` has no Effect equivalent, so module resolution stays raw.
 *
 * A path inside an asar archive is rejected: it resolves and stats fine, since
 * Electron's fs shim reads archives transparently — but an OS exec cannot
 * traverse one, and the SDK would fail late with a bare ENOTDIR.
 */
function sdkBinary(binary: string): string | undefined {
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
  bundled?: (binary: string) => string | undefined;
  platform?: NodeJS.Platform;
};

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
): Effect.Effect<string, ClaudeExecutableNotFound, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const {
      env = process.env,
      home = os.homedir(),
      bundled = sdkBinary,
      platform = process.platform,
    } = deps;
    const fs = yield* FileSystem.FileSystem;
    const isExecutable = (candidate: string) => isExecutableFile(fs, candidate, platform);

    const override =
      env["VIBEST_E2E"] === "1"
        ? env["VIBEST_E2E_CLAUDE_EXECUTABLE"]
        : env["VIBEST_CLAUDE_EXECUTABLE"];
    if (override) return override;

    const binary = platform === "win32" ? "claude.exe" : "claude";

    const fromSdk = bundled(binary);
    if (fromSdk && (yield* isExecutable(fromSdk))) return fromSdk;

    const dirs = [...(env["PATH"] ?? "").split(pathDelimiter(platform)), ...extraInstallDirs(home)];
    for (const dir of dirs) {
      if (!dir) continue;
      const candidate = path.join(dir, binary);
      if (yield* isExecutable(candidate)) return candidate;
    }

    return yield* Effect.fail(new ClaudeExecutableNotFound({ reason: NOT_FOUND }));
  });

/**
 * The CLI version vibest is built against: the version the Agent SDK bundles,
 * read from its manifest so the floor tracks the catalog bump automatically
 * (no hand-maintained constant). In a checkout the resolved binary IS this
 * version, so the floor never trips; only a user's own (older) install can.
 */
export const requiredClaudeVersion = (): Effect.Effect<string, Error, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const main = yield* Effect.try(() => moduleRequire.resolve("@anthropic-ai/claude-agent-sdk"));
    const raw = yield* fs.readFileString(path.join(path.dirname(main), "package.json"));
    const manifest = yield* Effect.try(() => JSON.parse(raw) as { claudeCodeVersion?: string });
    if (!manifest.claudeCodeVersion) {
      return yield* Effect.fail(
        new Error("Claude Agent SDK manifest is missing claudeCodeVersion."),
      );
    }
    return manifest.claudeCodeVersion;
  }).pipe(Effect.mapError((cause) => (cause instanceof Error ? cause : new Error(String(cause)))));

/**
 * Runs `<executable> --version`; returns its raw stdout (e.g. "2.1.216 (Claude Code)").
 *
 * Still `node:child_process`: `ChildProcessSpawner` supervises its children
 * through a `Scope`, and threading one into `checkAvailability` would push
 * `Scope` onto every harness adapter's availability check for a single
 * short-lived capture. Left as a follow-up rather than widened here.
 */
const readClaudeVersion = async (executable: string): Promise<string> => {
  const { stdout } = await execFileAsync(executable, ["--version"], { timeout: 5000 });
  return stdout.trim();
};

/** "2.1.216 (Claude Code)" → [2, 1, 216]; undefined when no x.y.z is present. */
function parseVersion(raw: string): readonly number[] | undefined {
  const match = raw.match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

function isBelow(actual: readonly number[], floor: readonly number[]): boolean {
  for (let i = 0; i < floor.length; i++) {
    const a = actual[i] ?? 0;
    const f = floor[i] ?? 0;
    if (a !== f) return a < f;
  }
  return false;
}

export type AvailabilityResult = { available: true } | { available: false; reason: string };

export type AvailabilityDeps = ResolveDeps & {
  /** Reads the CLI's reported version; injectable for tests. */
  readVersion?: (executable: string) => Promise<string>;
  /** The version floor; injectable for tests. */
  requiredVersion?: () => Effect.Effect<string, Error, FileSystem.FileSystem>;
};

/**
 * Is a usable Claude Code present? Fails closed only on a POSITIVELY too-old
 * CLI: a missing binary reports the resolve error, but an unreadable or
 * unparseable `--version` fails OPEN (available) rather than blocking on a
 * version we could not establish — the SDK will surface any real launch fault.
 */
export const checkClaudeAvailability = (
  deps: AvailabilityDeps = {},
): Effect.Effect<AvailabilityResult, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const executable = yield* resolveClaudeExecutable(deps).pipe(
      Effect.map((resolved) => ({ ok: true as const, path: resolved })),
      Effect.catch((cause) => Effect.succeed({ ok: false as const, reason: cause.message })),
    );
    if (!executable.ok) return { available: false, reason: executable.reason };

    // An unreadable floor is as unknowable as an unreadable version: fail open.
    const required = yield* (deps.requiredVersion ?? requiredClaudeVersion)().pipe(
      Effect.catch(() => Effect.succeed(undefined)),
    );
    const floor = required ? parseVersion(required) : undefined;

    const raw = yield* Effect.tryPromise(() =>
      (deps.readVersion ?? readClaudeVersion)(executable.path),
    ).pipe(Effect.catch(() => Effect.succeed(undefined)));
    if (raw === undefined) return { available: true };

    const actual = parseVersion(raw);
    if (required && floor && actual && isBelow(actual, floor)) {
      const reported = raw.split(/\s+/)[0] ?? raw;
      return {
        available: false,
        reason:
          `Claude Code ${reported} is too old — vibest requires ${required} or newer. ` +
          "Update it from https://claude.com/claude-code.",
      };
    }
    return { available: true };
  });
