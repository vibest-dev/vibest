import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const TIMEOUT_MS = 5_000;

// The shell prints arbitrary banner noise from the user's rc files, so the PATH
// is fenced rather than just echoed.
const OPEN = "__vibest_path_start__";
const CLOSE = "__vibest_path_end__";

function unfence(stdout: string): string | undefined {
  const start = stdout.indexOf(OPEN);
  const end = stdout.indexOf(CLOSE);
  if (start === -1 || end === -1 || end < start) return undefined;
  const value = stdout.slice(start + OPEN.length, end).trim();
  return value || undefined;
}

/**
 * The PATH the user's terminal would have.
 *
 * A GUI-launched macOS app inherits a bare `/usr/bin:/bin:/usr/sbin:/sbin` from
 * launchd — not the PATH from .zshrc, nvm, Homebrew, or the Claude Code native
 * installer. So the server would never find `claude`. Asking the login shell is
 * the standard repair, and what t3code does.
 *
 * Returns undefined on Windows (which has no such problem) or if the shell
 * fails, in which case the caller keeps the inherited PATH.
 */
export async function loginShellPath(): Promise<string | undefined> {
  if (process.platform === "win32") return undefined;

  const shell = process.env["SHELL"] || "/bin/zsh";
  try {
    // -i so interactive-only rc files (the usual home of PATH edits) are read.
    const { stdout } = await exec(shell, ["-ilc", `printf '%s%s%s' '${OPEN}' "$PATH" '${CLOSE}'`], {
      timeout: TIMEOUT_MS,
      encoding: "utf8",
    });
    return unfence(stdout);
  } catch {
    return undefined;
  }
}
