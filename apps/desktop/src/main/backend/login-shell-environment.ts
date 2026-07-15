import { Effect, Option } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const SHELL_TIMEOUT_MS = 5_000;
const LAUNCHCTL_TIMEOUT_MS = 2_000;

// Shell startup files may print arbitrary banner noise, so the NUL-delimited
// environment is fenced before parsing.
const OPEN = "__vibest_env_start__";
const CLOSE = "__vibest_env_end__";
const LAUNCHCTL_KEYS = [
  "PATH",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
] as const;

// The error stays `unknown` on purpose: every probe failure is swallowed into
// the base-environment fallback and never crosses this module's boundary.
export type RunCommand = (file: string, args: readonly string[]) => Effect.Effect<string, unknown>;

export type ShellEnvironmentOptions = {
  readonly platform?: NodeJS.Platform;
  readonly shell?: string;
  readonly baseEnv?: NodeJS.ProcessEnv;
};

function parseEnvironment(stdout: string): NodeJS.ProcessEnv | undefined {
  const openMarker = `\0${OPEN}\0`;
  const closeMarker = `\0${CLOSE}\0`;
  const start = stdout.indexOf(openMarker);
  const end = stdout.indexOf(closeMarker, start + openMarker.length);
  if (start === -1 || end === -1) return undefined;

  const environment: NodeJS.ProcessEnv = {};
  const body = stdout.slice(start + openMarker.length, end);
  for (const entry of body.split("\0")) {
    const separator = entry.indexOf("=");
    if (separator <= 0) continue;
    environment[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  return Object.keys(environment).length > 0 ? environment : undefined;
}

function runWithTimeout(run: RunCommand, file: string, args: readonly string[], timeoutMs: number) {
  return run(file, args).pipe(
    Effect.timeoutOption(timeoutMs),
    Effect.map(Option.getOrUndefined),
    Effect.catch(() => Effect.succeed(undefined)),
  );
}

function environmentFromLoginShell(run: RunCommand, shell: string) {
  const command = `printf '\\0%s\\0' '${OPEN}'; /usr/bin/env -0; printf '%s\\0' '${CLOSE}'`;
  return runWithTimeout(run, shell, ["-ilc", command], SHELL_TIMEOUT_MS).pipe(
    Effect.map((stdout) => (stdout === undefined ? undefined : parseEnvironment(stdout))),
  );
}

function environmentFromLaunchctl(run: RunCommand) {
  return Effect.all(
    LAUNCHCTL_KEYS.map((key) =>
      runWithTimeout(run, "/bin/launchctl", ["getenv", key], LAUNCHCTL_TIMEOUT_MS).pipe(
        Effect.map((stdout) => [key, stdout?.trim()] as const),
      ),
    ),
    { concurrency: "unbounded" },
  ).pipe(
    Effect.map((entries) => {
      const environment: NodeJS.ProcessEnv = {};
      for (const [key, value] of entries) {
        if (value) environment[key] = value;
      }
      return environment;
    }),
  );
}

/** Resolve the exported login-shell environment, falling back without failure. */
export function resolveLoginShellEnvironment(
  run: RunCommand,
  options: ShellEnvironmentOptions = {},
): Effect.Effect<NodeJS.ProcessEnv> {
  const platform = options.platform ?? process.platform;
  const shell = options.shell ?? process.env["SHELL"] ?? "/bin/zsh";
  const baseEnv = { ...(options.baseEnv ?? process.env) };

  return Effect.gen(function* () {
    if (platform === "win32") return baseEnv;

    const shellEnvironment = yield* environmentFromLoginShell(run, shell);
    if (shellEnvironment) return { ...baseEnv, ...shellEnvironment };
    if (platform !== "darwin") return baseEnv;

    const launchctlEnvironment = yield* environmentFromLaunchctl(run);
    return { ...baseEnv, ...launchctlEnvironment };
  });
}

export function resolveLoginShellEnvironmentWith(
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
): Effect.Effect<NodeJS.ProcessEnv> {
  return resolveLoginShellEnvironment((file, args) =>
    spawner.string(
      ChildProcess.make(file, args, {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
      }),
    ),
  );
}
