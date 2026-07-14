import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseReadyLine } from "@vibest/cli/handshake";
import { Context, Deferred, Effect, Layer, Scope, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  BackendExitedBeforeReady,
  BackendReadyTimeout,
  BackendSpawnError,
  type BackendStartError,
} from "./errors";

export const START_TIMEOUT_MS = 30_000;

export type BackendProcessConfig = {
  readonly entry: string;
  readonly token: string;
  readonly shellPath: string | undefined;
  readonly corsOrigins: readonly string[];
};

export type BackendProcessExit = {
  readonly exitCode: number | null;
};

export type RunningBackendProcess = {
  readonly ready: Effect.Effect<number, BackendStartError>;
  readonly awaitExit: Effect.Effect<BackendProcessExit, BackendSpawnError>;
};

export class BackendProcess extends Context.Service<
  BackendProcess,
  {
    readonly launch: (
      config: BackendProcessConfig,
      port: number,
    ) => Effect.Effect<RunningBackendProcess, BackendSpawnError, Scope.Scope>;
  }
>()("desktop/BackendProcess") {}

/**
 * Where the server bundle lives. The packaged app runs the collected CLI bundle
 * from its asar; unpackaged runs use the monorepo build output.
 */
export function resolveServerEntry(isPackaged: boolean, resourcesPath: string): string {
  if (isPackaged) {
    return path.join(
      resourcesPath,
      "app.asar",
      "node_modules",
      "@vibest",
      "cli",
      "dist",
      "cli.mjs",
    );
  }
  return fileURLToPath(new URL("../../../../packages/vibest/dist/cli.mjs", import.meta.url));
}

export function makeBackendToken(): string {
  return randomUUID();
}

function spawnError(message: string, cause: unknown): BackendSpawnError {
  return new BackendSpawnError({ message, cause });
}

export const BackendProcessLive = Layer.effect(
  BackendProcess,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    return BackendProcess.of({
      launch: (config, port) =>
        Effect.gen(function* () {
          const command = ChildProcess.make(process.execPath, [config.entry], {
            env: {
              ...(config.shellPath ? { PATH: config.shellPath } : {}),
              ELECTRON_RUN_AS_NODE: "1",
              VIBEST_AUTH_TOKEN: config.token,
              VIBEST_PORT: String(port),
              VIBEST_CORS_ORIGINS: config.corsOrigins.join(","),
            },
            extendEnv: true,
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
                spawnError(`Unable to start the backend process: ${String(cause)}`, cause),
              ),
            );

          const ready = yield* Deferred.make<number, BackendStartError>();
          const exited = yield* Deferred.make<BackendProcessExit, BackendSpawnError>();

          yield* handle.stdout.pipe(
            Stream.decodeText(),
            Stream.splitLines,
            Stream.runForEach((line) => {
              const parsed = parseReadyLine(line);
              if (parsed) return Deferred.succeed(ready, parsed.port).pipe(Effect.asVoid);
              return Effect.sync(() => console.log(`[vibest-server] ${line}`));
            }),
            Effect.catch((cause) =>
              Deferred.fail(
                ready,
                spawnError(`Failed to read backend stdout: ${String(cause)}`, cause),
              ).pipe(Effect.asVoid),
            ),
            Effect.forkScoped,
          );

          yield* handle.stderr.pipe(
            Stream.decodeText(),
            Stream.splitLines,
            Stream.runForEach((line) =>
              Effect.sync(() => console.error(`[vibest-server] ${line}`)),
            ),
            Effect.catch((cause) =>
              Effect.sync(() => console.error("[vibest-server] stderr failed", cause)),
            ),
            Effect.forkScoped,
          );

          yield* handle.exitCode.pipe(
            Effect.map((exitCode) => Number(exitCode)),
            Effect.tap((exitCode) =>
              Deferred.fail(
                ready,
                new BackendExitedBeforeReady({
                  exitCode,
                  message: `Backend exited during startup with code ${exitCode}`,
                }),
              ),
            ),
            Effect.flatMap((exitCode) => Deferred.succeed(exited, { exitCode })),
            Effect.catch((cause) => {
              const error = spawnError(
                `Failed while waiting for the backend: ${String(cause)}`,
                cause,
              );
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
                    new BackendReadyTimeout({
                      timeoutMs: START_TIMEOUT_MS,
                      message: `Backend did not report ready within ${START_TIMEOUT_MS}ms`,
                    }),
                  ),
              }),
            ),
            awaitExit: Deferred.await(exited),
          } satisfies RunningBackendProcess;
        }),
    });
  }),
);
