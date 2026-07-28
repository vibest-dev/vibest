import {
  type DaemonHandle,
  type DaemonPlatform,
  healthy,
  pidAlive,
  resolveOrSpawnDaemon,
  resolveVibestHome,
} from "@vibest/server/daemon";
import { Effect } from "effect";

import { ServerSpawnError, type ServerProcessExit, type SpawnServer } from "./local-server";

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const MAX_HEALTH_MISSES = 3;

export type DaemonServerProcessOptions = {
  /** How often to probe the attached daemon's liveness. */
  readonly pollIntervalMs?: number;
};

/**
 * The daemon-backed `SpawnServer`: instead of forking a die-with-app child,
 * attach the one `$VIBEST_HOME` daemon (spawning it detached if absent) via the
 * shared launcher — the same attach-or-spawn the CLI runs, so desktop and CLI
 * always converge on a single backend. Consequences the supervisor inherits:
 *
 * - The daemon outlives the app: closing this process's scope kills nothing.
 * - "Exit" has no child handle to wait on, so it is detected by polling the
 *   recorded pid + `/api/health`; when the daemon dies, the supervisor loop
 *   re-runs this spawner, which re-spawns through the launcher (auto-heal).
 * - Respawn attempts (port !== 0) set `autoRespawn`, so an explicit
 *   `vibest daemon stop` is respected: the launcher refuses to resurrect a
 *   tombstoned daemon and the supervisor surfaces "failed" instead. A fresh
 *   app launch (port === 0) is explicit intent and clears the tombstone.
 */
export function makeDaemonServerProcess(
  options: DaemonServerProcessOptions = {},
): Effect.Effect<SpawnServer, never, DaemonPlatform> {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  return Effect.gen(function* () {
    // The launcher's file state runs on the platform services; bind them once
    // here so the spawner still satisfies the supervisor's `SpawnServer` shape.
    const platform = yield* Effect.context<DaemonPlatform>();

    return (config, port) =>
      Effect.gen(function* () {
        const environment = {
          ...config.environment,
          // The daemon runs `node <entry>` via the Electron binary.
          ELECTRON_RUN_AS_NODE: "1",
        };

        const handle = yield* resolveOrSpawnDaemon({
          home: resolveVibestHome(config.environment),
          serverArgv: [process.execPath, config.entry],
          // 0 means "no preference" on the first attempt; afterwards the
          // supervisor pins the port it saw, which we pass as preferred.
          port: port === 0 ? undefined : port,
          environment,
          autoRespawn: port !== 0,
        }).pipe(
          Effect.mapError(
            (cause) =>
              new ServerSpawnError({
                message: `Unable to attach or spawn the vibest daemon: ${cause.message}`,
                cause,
              }),
          ),
        );

        const awaitExit: Effect.Effect<ServerProcessExit, ServerSpawnError> = Effect.gen(
          function* () {
            let misses = 0;
            while (true) {
              yield* Effect.sleep(pollIntervalMs);
              if (!pidAlive(handle.pid)) return { exitCode: null };
              // Tolerate transient probe failures; a wedged-but-alive daemon
              // still counts as dead after enough consecutive misses.
              misses = (yield* healthy(handle.address)) ? 0 : misses + 1;
              if (misses >= MAX_HEALTH_MISSES) return { exitCode: null };
            }
          },
        );

        return {
          ready: Effect.succeed(endpointOf(handle)),
          awaitExit,
        };
      }).pipe(Effect.provide(platform));
  });
}

function endpointOf(handle: DaemonHandle): { port: number; token: string } {
  return { port: handle.port, token: handle.token };
}
