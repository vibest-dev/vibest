import childProcess from "node:child_process";
import fs from "node:fs";
import module from "node:module";
import os from "node:os";
import path from "node:path";
import util from "node:util";

const moduleRequire = module.createRequire(import.meta.url);
const execFileAsync = util.promisify(childProcess.execFile);

/** Where the native installer and the common package managers put `claude`. */
function extraInstallDirs(home: string): string[] {
  return [
    path.join(home, ".local", "bin"),
    path.join(home, ".bun", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
}

function isExecutableFile(candidate: string): boolean {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The version-matched binary the Claude Agent SDK ships as an optional platform
 * dependency. Present when running from a checkout; absent in the packaged
 * desktop app, which excludes it (it is ~230 MB — the user's own Claude Code
 * install is used there instead).
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
  isExecutable?: (candidate: string) => boolean;
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
export function resolveClaudeExecutable(deps: ResolveDeps = {}): string {
  const {
    env = process.env,
    home = os.homedir(),
    bundled = sdkBinary,
    isExecutable = isExecutableFile,
    platform = process.platform,
  } = deps;

  const override =
    env["VIBEST_E2E"] === "1"
      ? env["VIBEST_E2E_CLAUDE_EXECUTABLE"]
      : env["VIBEST_CLAUDE_EXECUTABLE"];
  if (override) return override;

  const binary = platform === "win32" ? "claude.exe" : "claude";

  const fromSdk = bundled(binary);
  if (fromSdk && isExecutable(fromSdk)) return fromSdk;

  const dirs = [...(env["PATH"] ?? "").split(path.delimiter), ...extraInstallDirs(home)];
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = path.join(dir, binary);
    if (isExecutable(candidate)) return candidate;
  }

  throw new Error(
    "Claude Code was not found. Install it from https://claude.com/claude-code, " +
      "or set VIBEST_CLAUDE_EXECUTABLE to the path of the `claude` binary.",
  );
}

/**
 * The CLI version vibest is built against: the version the Agent SDK bundles,
 * read from its manifest so the floor tracks the catalog bump automatically
 * (no hand-maintained constant). In a checkout the resolved binary IS this
 * version, so the floor never trips; only a user's own (older) install can.
 */
export function requiredClaudeVersion(): string {
  const main = moduleRequire.resolve("@anthropic-ai/claude-agent-sdk");
  const manifest = JSON.parse(
    fs.readFileSync(path.join(path.dirname(main), "package.json"), "utf8"),
  ) as { claudeCodeVersion?: string };
  if (!manifest.claudeCodeVersion) {
    throw new Error("Claude Agent SDK manifest is missing claudeCodeVersion.");
  }
  return manifest.claudeCodeVersion;
}

/** Runs `<executable> --version`; returns its raw stdout (e.g. "2.1.216 (Claude Code)"). */
async function readClaudeVersion(executable: string): Promise<string> {
  const { stdout } = await execFileAsync(executable, ["--version"], { timeout: 5000 });
  return stdout.trim();
}

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
  requiredVersion?: () => string;
};

/**
 * Is a usable Claude Code present? Fails closed only on a POSITIVELY too-old
 * CLI: a missing binary reports the resolve error, but an unreadable or
 * unparseable `--version` fails OPEN (available) rather than blocking on a
 * version we could not establish — the SDK will surface any real launch fault.
 */
export async function checkClaudeAvailability(
  deps: AvailabilityDeps = {},
): Promise<AvailabilityResult> {
  let executable: string;
  try {
    executable = resolveClaudeExecutable(deps);
  } catch (cause) {
    return { available: false, reason: cause instanceof Error ? cause.message : String(cause) };
  }

  const required = (deps.requiredVersion ?? requiredClaudeVersion)();
  const floor = parseVersion(required);

  let raw: string;
  try {
    raw = await (deps.readVersion ?? readClaudeVersion)(executable);
  } catch {
    return { available: true };
  }

  const actual = parseVersion(raw);
  if (floor && actual && isBelow(actual, floor)) {
    const reported = raw.split(/\s+/)[0] ?? raw;
    return {
      available: false,
      reason:
        `Claude Code ${reported} is too old — vibest requires ${required} or newer. ` +
        "Update it from https://claude.com/claude-code.",
    };
  }
  return { available: true };
}
