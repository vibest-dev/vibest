import { Effect, type FileSystem } from "effect";

import { ExecutableNotFound } from "../errors";
import { searchInstallDirs, type ResolveExecutableDeps } from "../executable";

const NOT_FOUND =
  "Codex was not found. Install it from https://github.com/openai/codex, " +
  "or set VIBEST_CODEX_EXECUTABLE to the path of the `codex` binary.";

/**
 * The `codex` binary to spawn.
 *
 * Codex is the one harness vibest does not ship a copy of, so its order is the
 * shortest of the three: an explicit override, else the user's own install.
 * An override wins unverified — naming a path is the user saying "this one".
 *
 * The fallback directories the search walks after PATH are not incidental
 * here: the common way to install codex is `bun install -g @openai/codex`,
 * which lands it in `~/.bun/bin` — a directory present in an interactive
 * shell's PATH and absent from a systemd unit's.
 */
export const resolveCodexExecutable = (
  deps: ResolveExecutableDeps = {},
): Effect.Effect<string, ExecutableNotFound, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const override = (deps.env ?? process.env)["VIBEST_CODEX_EXECUTABLE"];
    if (override) return override;

    const installed = yield* searchInstallDirs("codex", deps);
    if (installed) return installed;

    return yield* Effect.fail(
      new ExecutableNotFound({
        harnessAgentId: "codex",
        executable: "codex",
        reason: NOT_FOUND,
      }),
    );
  });
