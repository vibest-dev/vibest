import fs from "node:fs";
import path from "node:path";

/**
 * Locating the CLI a harness spawns. Claude Code has its own resolver (it
 * prefers the version-matched binary the SDK ships); the harnesses that just
 * exec a bare command off PATH — codex, pi — share this one.
 *
 * It exists for availability: `negotiate` has to answer "is this harness usable
 * right now" before it spends anything probing capabilities, and a missing
 * binary is the common case on a machine where the user only installed one
 * agent. A PATH lookup answers that synchronously; spawning to find out would
 * make the app's first paint wait on a process that was never going to start.
 *
 * It searches PATH and nothing else, deliberately. The transports spawn the
 * bare command name (`spawn("codex")`), which the OS resolves through PATH
 * alone — so any directory this looked in beyond PATH would make it report a
 * harness available that then fails to spawn, turning an actionable "not found
 * on PATH" into an opaque ENOENT at session-create time. Whatever fixes PATH
 * for the spawn (the desktop's login-shell environment) fixes it for both.
 */

/**
 * Windows resolves a bare name through PATHEXT, and npm-installed CLIs land as
 * `.cmd` shims rather than `.exe` — checking only `.exe` would report every one
 * of them missing.
 */
const WINDOWS_EXTENSIONS = [".com", ".exe", ".bat", ".cmd"];

function candidateNames(command: string, platform: NodeJS.Platform): string[] {
  if (platform !== "win32") return [command];
  if (path.extname(command)) return [command];
  return WINDOWS_EXTENSIONS.map((extension) => `${command}${extension}`);
}

function isExecutableFile(candidate: string): boolean {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export type FindExecutableDeps = {
  env?: NodeJS.ProcessEnv;
  isExecutable?: (candidate: string) => boolean;
  platform?: NodeJS.Platform;
};

/**
 * The path a bare command name resolves to, or `undefined` when it is not
 * installed. An absolute `command` is taken as an explicit override and only
 * checked for executability.
 */
export function findExecutable(command: string, deps: FindExecutableDeps = {}): string | undefined {
  const { env = process.env, isExecutable = isExecutableFile, platform = process.platform } = deps;

  if (path.isAbsolute(command)) return isExecutable(command) ? command : undefined;

  const names = candidateNames(command, platform);
  for (const dir of (env["PATH"] ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return undefined;
}
