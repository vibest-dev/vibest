import { Effect, Option } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const SHELL_TIMEOUT_MS = 5_000;
const LAUNCHCTL_TIMEOUT_MS = 2_000;

// The shell prints arbitrary banner noise from the user's rc files, so the PATH
// is fenced rather than just echoed.
const OPEN = "__vibest_path_start__";
const CLOSE = "__vibest_path_end__";

export type RunCommand = (
  file: string,
  args: readonly string[],
  timeoutMs: number,
) => Effect.Effect<string, unknown>;

export type ShellPathOptions = {
  readonly platform?: NodeJS.Platform;
  readonly shell?: string;
};

function unfence(stdout: string): string | undefined {
  const start = stdout.indexOf(OPEN);
  const end = stdout.indexOf(CLOSE);
  if (start === -1 || end === -1 || end < start) return undefined;
  const value = stdout.slice(start + OPEN.length, end).trim();
  return value || undefined;
}

function runWithTimeout(run: RunCommand, file: string, args: readonly string[], timeoutMs: number) {
  return run(file, args, timeoutMs).pipe(
    Effect.timeoutOption(timeoutMs),
    Effect.map(Option.getOrUndefined),
    Effect.catch(() => Effect.succeed(undefined)),
  );
}

function pathFromLoginShell(run: RunCommand, shell: string) {
  // `printenv`, rather than interpolating $PATH, keeps fish's exported PATH
  // colon-separated. `-i` loads interactive-only PATH edits.
  const command = `printf '%s' '${OPEN}'; printenv PATH || true; printf '%s' '${CLOSE}'`;
  return runWithTimeout(run, shell, ["-ilc", command], SHELL_TIMEOUT_MS).pipe(
    Effect.map((stdout) => (stdout === undefined ? undefined : unfence(stdout))),
  );
}

function pathFromLaunchctl(run: RunCommand) {
  return runWithTimeout(run, "/bin/launchctl", ["getenv", "PATH"], LAUNCHCTL_TIMEOUT_MS).pipe(
    Effect.map((stdout) => {
      const value = stdout?.trim();
      return value || undefined;
    }),
  );
}

/** Resolve the PATH a terminal login shell exports, falling back without failure. */
export function resolveLoginShellPath(
  run: RunCommand,
  options: ShellPathOptions = {},
): Effect.Effect<string | undefined> {
  const platform = options.platform ?? process.platform;
  const shell = options.shell ?? process.env["SHELL"] ?? "/bin/zsh";

  return Effect.gen(function* () {
    if (platform === "win32") return undefined;

    const shellPath = yield* pathFromLoginShell(run, shell);
    if (shellPath) return shellPath;
    if (platform !== "darwin") return undefined;
    return yield* pathFromLaunchctl(run);
  });
}

export function resolveLoginShellPathWith(
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
): Effect.Effect<string | undefined> {
  return resolveLoginShellPath((file, args) =>
    spawner.string(
      ChildProcess.make(file, args, {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
      }),
    ),
  );
}
