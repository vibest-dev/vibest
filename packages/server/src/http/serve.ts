import { Cause, Context, Effect, Option, Scope } from "effect";
import { Command, Flag } from "effect/unstable/cli";

import { PathsLayer } from "../config/paths";
import * as Observability from "../observability";
import { formatReadyLine } from "./handshake";
import { listenServer } from "./listen";
import { createServer, ServerStartupError } from "./server";

const DEFAULT_PORT = 4000;

/**
 * Read the token, then scrub it. The agent spawns a shell for every tool call
 * and children inherit this environment — an agent-run command must not be
 * able to read the credential that guards the agent. Kept env-only (never a
 * flag) so it stays out of the process list.
 */
function takeAuthToken(): string | undefined {
  const token = process.env.VIBEST_AUTH_TOKEN;
  delete process.env.VIBEST_AUTH_TOKEN;
  return token;
}

function listFromEnv(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function portFromEnv(): number {
  const raw = process.env.VIBEST_PORT;
  if (raw === undefined) return process.env.NODE_ENV === "development" ? 0 : DEFAULT_PORT;
  const port = Number.parseInt(raw, 10);
  return Number.isInteger(port) && port >= 0 ? port : DEFAULT_PORT;
}

export const serveFlags = {
  port: Flag.integer("port").pipe(
    Flag.withDescription("Port to listen on (overrides VIBEST_PORT)"),
    Flag.optional,
  ),
  corsOrigin: Flag.string("cors-origin").pipe(
    Flag.withDescription("Origin allowed to make cross-origin requests; repeatable"),
    Flag.atLeast(0),
  ),
  allowedHost: Flag.string("allowed-host").pipe(
    Flag.withDescription(
      "Extra Host header accepted besides loopback, for a trusted reverse proxy; repeatable",
    ),
    Flag.atLeast(0),
  ),
};

type ServeInput = {
  readonly port: Option.Option<number>;
  readonly corsOrigin: ReadonlyArray<string>;
  readonly allowedHost: ReadonlyArray<string>;
};

/**
 * Resolve the effective port and CORS origins from parsed flags, falling back
 * to `VIBEST_*` env and finally the defaults — precedence flag > env > default.
 * Pure so the precedence can be tested without booting a server.
 */
export function resolveServeConfig(input: ServeInput): {
  readonly port: number;
  readonly corsOrigins: readonly string[];
  readonly allowedHosts: readonly string[];
} {
  return {
    port: Option.getOrElse(input.port, portFromEnv),
    corsOrigins:
      input.corsOrigin.length > 0 ? input.corsOrigin : listFromEnv("VIBEST_CORS_ORIGINS"),
    allowedHosts:
      input.allowedHost.length > 0 ? input.allowedHost : listFromEnv("VIBEST_ALLOWED_HOSTS"),
  };
}

/**
 * Boot the HTTP server and keep the process alive until interrupted.
 * The auth token is env-only. The server is acquired in the ambient scope so
 * `NodeRuntime.runMain`'s SIGINT/SIGTERM interrupt tears it down through the
 * release finalizer.
 *
 * This is the process composition root for observability. The layer is
 * provided once around the complete server lifecycle, so foreground and
 * daemon runs share the same local logger. FileSystem and Crypto stay on
 * the outer `NodeServices.layer`; Paths is provided here so the log
 * directory is the same `logsDir` the rest of the process uses.
 *
 * `createServer` is Promise-shaped, so `serveWith` captures the process
 * context (logger included) and `createRpcRuntime` `provideMerge`s it into
 * `AgentRuntimeLayer`. That merge must stay `provideMerge`, not `mergeAll`:
 * fibers forked while the graph is building would otherwise capture Effect's
 * default logger.
 */
export const runServe = (input: ServeInput) =>
  serveWith(input).pipe(
    Effect.tapError((error) =>
      Effect.logError("server startup failed", Cause.fail(error)).pipe(
        Effect.annotateLogs({ event: "server.startup_failed", phase: error.phase }),
      ),
    ),
    Effect.provide(Observability.layer()),
    Effect.provide(PathsLayer),
  );

const serveWith = (input: ServeInput) =>
  Effect.gen(function* () {
    const authToken = takeAuthToken();
    const { port: requestedPort, corsOrigins, allowedHosts } = resolveServeConfig(input);

    // The first line of every run, and the one that dates the file. It also
    // records the shape of the run — auth on or off, which origins are allowed
    // — because a misconfiguration explains failures that otherwise look like
    // the client's fault.
    yield* Effect.logInfo("server starting").pipe(
      Effect.annotateLogs({
        event: "server.starting",
        requestedPort,
        authenticated: authToken !== undefined,
        corsOrigins,
        allowedHosts,
        version: process.env.npm_package_version,
        node: process.version,
      }),
    );

    const effectContext = Context.omit(Scope.Scope)(yield* Effect.context<never>());
    const server = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => createServer({ authToken, corsOrigins, allowedHosts, effectContext }),
        catch: (cause) => new ServerStartupError({ phase: "create", cause }),
      }),
      // A shutdown failure is logged, not thrown: the process is exiting, and
      // a defect here would mask whatever caused the exit in the first place.
      //
      // The clean stop is logged too: a log that ends without it ended in a
      // kill -9, an OOM, or a crash, and knowing which is the first question
      // when reading back a run that stopped for no visible reason.
      (managed) =>
        Effect.tryPromise(() => managed.dispose()).pipe(
          Effect.andThen(
            Effect.logInfo("server stopped").pipe(Effect.annotateLogs({ event: "server.stopped" })),
          ),
          Effect.catch((error) => Effect.logWarning("server shutdown failed", error)),
        ),
    );

    const port = yield* Effect.tryPromise({
      try: () => listenServer(server, requestedPort),
      catch: (cause) => new ServerStartupError({ phase: "listen", cause }),
    });

    // Machine-readable first, for the desktop supervisor; human-readable
    // second. Both go to stdout; observability writes to the local log file and
    // only mirrors to stderr when `VIBEST_PRINT_LOGS=1`.
    console.log(formatReadyLine({ port }));
    console.log(`vibest listening on http://127.0.0.1:${port}`);

    yield* Effect.logInfo("server listening").pipe(
      Effect.annotateLogs({ event: "server.listening", port }),
    );

    return yield* Effect.never;
  });

export const serve = Command.make("serve", serveFlags, runServe).pipe(
  Command.withDescription("Start the vibest local server"),
);
