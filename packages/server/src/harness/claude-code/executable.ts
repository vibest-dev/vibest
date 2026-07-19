import { accessSync, constants } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";

const moduleRequire = createRequire(import.meta.url);

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
    accessSync(candidate, constants.X_OK);
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
    home = homedir(),
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
