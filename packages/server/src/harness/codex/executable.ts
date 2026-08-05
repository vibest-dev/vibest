import type { HarnessExecutableSpec } from "../executable";

/**
 * Codex is the one harness vibest does not ship a copy of, so it has no
 * bundled level — the user's own install is the only candidate, found on PATH
 * or in one of the shared fallback directories.
 *
 * That fallback level is not incidental here: the common way to install codex
 * is `bun install -g @openai/codex`, which lands it in `~/.bun/bin` — a
 * directory present in an interactive shell's PATH and absent from a systemd
 * unit's.
 */
export const codexExecutableSpec: HarnessExecutableSpec = {
  harnessAgentId: "codex",
  binaryName: "codex",
  override: (env) => env["VIBEST_CODEX_EXECUTABLE"],
  notFoundReason:
    "Codex was not found. Install it from https://github.com/openai/codex, " +
    "or set VIBEST_CODEX_EXECUTABLE to the path of the `codex` binary.",
};
