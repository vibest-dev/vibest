import { execFile } from "node:child_process";
import { promisify } from "node:util";

const defaultExec = promisify(execFile);

const SHELL_TIMEOUT_MS = 5_000;
const LAUNCHCTL_TIMEOUT_MS = 2_000;

// The shell prints arbitrary banner noise from the user's rc files, so the PATH
// is fenced rather than just echoed.
const OPEN = "__vibest_path_start__";
const CLOSE = "__vibest_path_end__";

/** Runs a command and resolves its stdout; rejects on non-zero exit or timeout. */
export type Exec = (
  file: string,
  args: readonly string[],
  options: { timeout: number; encoding: "utf8" },
) => Promise<{ stdout: string }>;

export type ShellPathDeps = {
  exec?: Exec;
  platform?: NodeJS.Platform;
  shell?: string;
};

function unfence(stdout: string): string | undefined {
  const start = stdout.indexOf(OPEN);
  const end = stdout.indexOf(CLOSE);
  if (start === -1 || end === -1 || end < start) return undefined;
  const value = stdout.slice(start + OPEN.length, end).trim();
  return value || undefined;
}

/**
 * PATH as reported by the user's login shell.
 *
 * `printenv PATH`, not `"$PATH"`: the value must come from an *external command*
 * reading the exported environment, never from interpolating the shell's own
 * PATH variable. fish stores that variable as a space-separated list, so
 * `"$PATH"` would come back space-delimited and unusable — `printenv` always
 * prints the colon-joined exported form, whatever the shell. (opencode dumps the
 * whole env via `env -0` for the same reason; t3code uses `printenv`.)
 *
 * `|| true` so a shell with no PATH exported still exits zero.
 */
async function pathFromLoginShell(exec: Exec, shell: string): Promise<string | undefined> {
  // -i so interactive-only rc files (the usual home of PATH edits) are read.
  const command = `printf '%s' '${OPEN}'; printenv PATH || true; printf '%s' '${CLOSE}'`;
  const { stdout } = await exec(shell, ["-ilc", command], {
    timeout: SHELL_TIMEOUT_MS,
    encoding: "utf8",
  });
  return unfence(stdout);
}

/**
 * PATH from launchd's per-user environment (`launchctl getenv PATH`).
 *
 * The fallback when the login-shell probe yields nothing — a nushell user (whose
 * shell rejects `-ilc`), or one whose rc files stall past the timeout. Anyone who
 * ran `launchctl setenv PATH` (or a tool that did) still gets a usable PATH here.
 */
async function pathFromLaunchctl(exec: Exec): Promise<string | undefined> {
  const { stdout } = await exec("/bin/launchctl", ["getenv", "PATH"], {
    timeout: LAUNCHCTL_TIMEOUT_MS,
    encoding: "utf8",
  });
  const value = stdout.trim();
  return value || undefined;
}

/**
 * The PATH the user's terminal would have.
 *
 * A GUI-launched macOS app inherits a bare `/usr/bin:/bin:/usr/sbin:/sbin` from
 * launchd — not the PATH from .zshrc, nvm, Homebrew, or the Claude Code native
 * installer. So the server would never find `claude`. Asking the login shell is
 * the standard repair, with `launchctl` as a fallback (both what t3code does).
 *
 * Returns undefined on Windows (which has no such problem) or if every probe
 * fails, in which case the caller keeps the inherited PATH.
 */
export async function loginShellPath(deps: ShellPathDeps = {}): Promise<string | undefined> {
  const { exec = defaultExec, platform = process.platform, shell = process.env["SHELL"] } = deps;

  if (platform === "win32") return undefined;

  try {
    const fromShell = await pathFromLoginShell(exec, shell || "/bin/zsh");
    if (fromShell) return fromShell;
  } catch {
    // Fall through to launchctl.
  }

  if (platform === "darwin") {
    try {
      return await pathFromLaunchctl(exec);
    } catch {
      return undefined;
    }
  }

  return undefined;
}
