import { Effect, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";

import { formatReadyLine } from "./handshake";
import { listenServer } from "./listen";
import { createServer } from "./server";

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

function corsOriginsFromEnv(): string[] {
  return (process.env.VIBEST_CORS_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
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
};

type ServeInput = {
  readonly port: Option.Option<number>;
  readonly corsOrigin: ReadonlyArray<string>;
};

/**
 * Resolve the effective port and CORS origins from parsed flags, falling back
 * to `VIBEST_*` env and finally the defaults — precedence flag > env > default.
 * Pure so the precedence can be tested without booting a server.
 */
export function resolveServeConfig(input: ServeInput): {
  readonly port: number;
  readonly corsOrigins: readonly string[];
} {
  return {
    port: Option.getOrElse(input.port, portFromEnv),
    corsOrigins: input.corsOrigin.length > 0 ? input.corsOrigin : corsOriginsFromEnv(),
  };
}

/**
 * Boot the HTTP server and keep the process alive until interrupted.
 * The auth token is env-only. The server is acquired in the ambient scope so
 * `NodeRuntime.runMain`'s SIGINT/SIGTERM interrupt tears it down through the
 * release finalizer.
 */
export const runServe = (input: ServeInput) =>
  Effect.gen(function* () {
    const authToken = takeAuthToken();
    const { port: requestedPort, corsOrigins } = resolveServeConfig(input);

    const server = yield* Effect.acquireRelease(
      Effect.promise(() => createServer({ authToken, corsOrigins })),
      (managed) => Effect.promise(() => managed.dispose()),
    );

    const port = yield* Effect.tryPromise(() => listenServer(server, requestedPort));

    // Machine-readable first, for the desktop supervisor; human-readable second.
    // Both go to stdout — Effect's logger writes to stderr, so it never mixes in.
    console.log(formatReadyLine({ port }));
    console.log(`vibest listening on http://127.0.0.1:${port}`);

    return yield* Effect.never;
  });

export const serve = Command.make("serve", serveFlags, runServe).pipe(
  Command.withDescription("Start the vibest local server"),
);
