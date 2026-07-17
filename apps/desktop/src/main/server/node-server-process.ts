import { parseReadyLine } from "@vibest/cli/handshake";
import { Deferred, Effect, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  ServerExitedBeforeReady,
  ServerReadyTimeout,
  ServerSpawnError,
  type ServerStartError,
  type SpawnServer,
} from "./local-server";

export const START_TIMEOUT_MS = 30_000;

function spawnError(message: string, cause: unknown): ServerSpawnError {
  return new ServerSpawnError({ message, cause });
}

export function makeNodeServerProcess(
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
): SpawnServer {
  return (config, port) =>
    Effect.gen(function* () {
      const command = ChildProcess.make(process.execPath, [config.entry], {
        env: {
          ...config.environment,
          ELECTRON_RUN_AS_NODE: "1",
          VIBEST_AUTH_TOKEN: config.token,
          VIBEST_PORT: String(port),
          VIBEST_CORS_ORIGINS: config.corsOrigins.join(","),
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        killSignal: "SIGTERM",
        forceKillAfter: "1 second",
      });

      const handle = yield* spawner
        .spawn(command)
        .pipe(
          Effect.mapError((cause) =>
            spawnError(`Unable to start the server process: ${String(cause)}`, cause),
          ),
        );

      const ready = yield* Deferred.make<number, ServerStartError>();
      const exited = yield* Deferred.make<{ readonly exitCode: number | null }, ServerSpawnError>();

      yield* handle.stdout.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.runForEach((line) => {
          const parsed = parseReadyLine(line);
          if (parsed) return Deferred.succeed(ready, parsed.port).pipe(Effect.asVoid);
          return Effect.log(line);
        }),
        Effect.catch((cause) =>
          Deferred.fail(
            ready,
            spawnError(`Failed to read server stdout: ${String(cause)}`, cause),
          ).pipe(Effect.asVoid),
        ),
        Effect.annotateLogs({ source: "vibest-server", fd: "stdout" }),
        Effect.forkScoped,
      );

      yield* handle.stderr.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.runForEach((line) => Effect.logError(line)),
        Effect.catch((cause) => Effect.logError("stderr failed", cause)),
        Effect.annotateLogs({ source: "vibest-server", fd: "stderr" }),
        Effect.forkScoped,
      );

      yield* handle.exitCode.pipe(
        Effect.map((exitCode) => Number(exitCode)),
        Effect.tap((exitCode) =>
          Deferred.fail(
            ready,
            new ServerExitedBeforeReady({
              exitCode,
              message: `Server exited during startup with code ${exitCode}`,
            }),
          ),
        ),
        Effect.flatMap((exitCode) => Deferred.succeed(exited, { exitCode })),
        Effect.catch((cause) => {
          const error = spawnError(`Failed while waiting for the server: ${String(cause)}`, cause);
          return Deferred.fail(ready, error).pipe(
            Effect.andThen(Deferred.fail(exited, error)),
            Effect.asVoid,
          );
        }),
        Effect.forkScoped,
      );

      return {
        ready: Deferred.await(ready).pipe(
          Effect.timeoutOrElse({
            duration: START_TIMEOUT_MS,
            orElse: () =>
              Effect.fail(
                new ServerReadyTimeout({
                  timeoutMs: START_TIMEOUT_MS,
                  message: `Server did not report ready within ${START_TIMEOUT_MS}ms`,
                }),
              ),
          }),
        ),
        awaitExit: Deferred.await(exited),
      };
    });
}
