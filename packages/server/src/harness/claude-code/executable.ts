import childProcess from "node:child_process";
import module from "node:module";
import path from "node:path";
import util from "node:util";

import { Effect, FileSystem } from "effect";

import type { ExecutableNotFound } from "../errors";
import {
  type HarnessExecutableSpec,
  type ResolveExecutableDeps,
  resolveHarnessExecutable,
} from "../executable";

const moduleRequire = module.createRequire(import.meta.url);
const execFileAsync = util.promisify(childProcess.execFile);

const NOT_FOUND =
  "Claude Code was not found. Install it from https://claude.com/claude-code, " +
  "or set VIBEST_CLAUDE_EXECUTABLE to the path of the `claude` binary.";

/**
 * The version-matched binary the Claude Agent SDK ships as an optional platform
 * dependency. Its version is pinned to the SDK's wire protocol, so it is
 * preferred over the user's own install whenever it is really on disk — absent
 * in the packaged desktop app, which excludes it (~230 MB) and uses the user's
 * install instead.
 *
 * Resolved in two hops, and that is the whole trick: the platform package is an
 * optionalDependency *of the SDK*, so under pnpm's strict layout it is not
 * visible from this module at all — a direct
 * `require.resolve("@anthropic-ai/claude-agent-sdk-linux-x64/claude")` throws
 * MODULE_NOT_FOUND in every pnpm checkout, which is exactly what it did, so
 * this level never once fired and every install silently fell through to PATH.
 * Resolving the SDK's own entry first (that hop always succeeds — it is a
 * direct dependency) and asking *from there* puts the platform package back in
 * view.
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
    const sdkEntry = moduleRequire.resolve("@anthropic-ai/claude-agent-sdk");
    const resolved = module.createRequire(sdkEntry).resolve(`${pkg}/${binary}`);
    return resolved.includes(`.asar${path.sep}`) ? undefined : resolved;
  } catch {
    return undefined;
  }
}

/**
 * `VIBEST_E2E_CLAUDE_EXECUTABLE` is gated on `VIBEST_E2E` so a test fixture can
 * never be picked up by a real install that happens to have the variable set.
 */
export const claudeExecutableSpec: HarnessExecutableSpec = {
  harnessAgentId: "claude-code",
  binaryName: "claude",
  override: (env) =>
    env["VIBEST_E2E"] === "1"
      ? env["VIBEST_E2E_CLAUDE_EXECUTABLE"]
      : env["VIBEST_CLAUDE_EXECUTABLE"],
  bundled: sdkBinary,
  notFoundReason: NOT_FOUND,
};

export type ResolveDeps = ResolveExecutableDeps & {
  /** The SDK's own bundled binary, if it is really on disk. Injectable for tests. */
  bundled?: (binary: string) => string | undefined;
};

/** The `claude` binary the SDK should exec. */
export const resolveClaudeExecutable = (
  deps: ResolveDeps = {},
): Effect.Effect<string, ExecutableNotFound, FileSystem.FileSystem> => {
  const { bundled, ...rest } = deps;
  return resolveHarnessExecutable(
    bundled ? { ...claudeExecutableSpec, bundled } : claudeExecutableSpec,
    rest,
  );
};

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
 * through a `Scope`, and threading one into `availability` would push
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
  /**
   * The resolve to check, so availability and the spawn can be the *same*
   * answer rather than two walks that may disagree. Defaults to resolving on
   * the spot, which is what tests and any standalone caller want.
   */
  resolve?: Effect.Effect<string, ExecutableNotFound, FileSystem.FileSystem>;
};

/**
 * Is a usable Claude Code present? Fails closed only on a POSITIVELY too-old
 * CLI: a missing binary reports the resolve error, but an unreadable or
 * unparseable `--version` fails OPEN (available) rather than blocking on a
 * version we could not establish — the SDK will surface any real launch fault.
 *
 * The version floor is what stays claude-code's own: finding the binary is the
 * shared walk, verifying it is new enough to speak the SDK's protocol is not.
 */
export const claudeAvailability = (
  deps: AvailabilityDeps = {},
): Effect.Effect<AvailabilityResult, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const executable = yield* (deps.resolve ?? resolveClaudeExecutable(deps)).pipe(
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
