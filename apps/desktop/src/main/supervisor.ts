import {
  Clock,
  Context,
  Deferred,
  Effect,
  Layer,
  Queue,
  Result,
  Stream,
  SubscriptionRef,
} from "effect";

import type {
  BackendConnection,
  BackendStatus,
  BackendStatusSnapshot,
} from "../shared/desktop-rpc";
import { type BackendProcessConfig, BackendProcess } from "./backend";
import type { BackendStartError } from "./errors";
import { LoginShellPath } from "./shell-path";

export type { BackendStatus };

const DEFAULTS = {
  initialRestartDelayMs: 500,
  maxRestartDelayMs: 10_000,
  maxFastFailures: 5,
  stableAfterMs: 10_000,
};

export type BackendSupervisorOptions = {
  readonly entry: string;
  readonly token: string;
  readonly corsOrigins: readonly string[];
  readonly useLoginShellPath: boolean;
  readonly initialRestartDelayMs?: number;
  readonly maxRestartDelayMs?: number;
  readonly maxFastFailures?: number;
  readonly stableAfterMs?: number;
};

export class BackendSupervisor extends Context.Service<
  BackendSupervisor,
  {
    readonly connection: BackendConnection;
    readonly status: Effect.Effect<BackendStatus>;
    readonly snapshot: Effect.Effect<BackendStatusSnapshot>;
    readonly changes: Stream.Stream<BackendStatusSnapshot>;
    readonly retry: Effect.Effect<void>;
  }
>()("desktop/BackendSupervisor") {}

export function restartBackoff(
  failureCount: number,
  initialDelayMs = DEFAULTS.initialRestartDelayMs,
  maxDelayMs = DEFAULTS.maxRestartDelayMs,
): number {
  return Math.min(initialDelayMs * 2 ** (failureCount - 1), maxDelayMs);
}

function setStatus(
  ref: SubscriptionRef.SubscriptionRef<BackendStatusSnapshot>,
  next: BackendStatus,
) {
  return Effect.gen(function* () {
    const current = yield* SubscriptionRef.get(ref);
    if (current.status !== next) {
      yield* SubscriptionRef.set(ref, {
        revision: current.revision + 1,
        status: next,
      });
    }
  });
}

export function makeBackendSupervisorLayer(
  options: BackendSupervisorOptions,
): Layer.Layer<BackendSupervisor, BackendStartError, BackendProcess | LoginShellPath> {
  return Layer.effect(
    BackendSupervisor,
    Effect.gen(function* () {
      const process = yield* BackendProcess;
      const loginShell = yield* LoginShellPath;
      const shellPath = options.useLoginShellPath ? yield* loginShell.get : undefined;
      const statusRef = yield* SubscriptionRef.make<BackendStatusSnapshot>({
        revision: 0,
        status: "starting",
      });
      const retryQueue = yield* Queue.dropping<void>(1);
      const initial = yield* Deferred.make<BackendConnection, BackendStartError>();

      const config: BackendProcessConfig = {
        entry: options.entry,
        token: options.token,
        shellPath,
        corsOrigins: options.corsOrigins,
      };
      const initialDelay = options.initialRestartDelayMs ?? DEFAULTS.initialRestartDelayMs;
      const maxDelay = options.maxRestartDelayMs ?? DEFAULTS.maxRestartDelayMs;
      const maxFailures = options.maxFastFailures ?? DEFAULTS.maxFastFailures;
      const stableAfter = options.stableAfterMs ?? DEFAULTS.stableAfterMs;

      const supervise = Effect.gen(function* () {
        let first = true;
        let pinnedPort = 0;
        let fastFailures = 0;

        while (true) {
          let readyAt: number | undefined;

          const attempt = yield* Effect.scoped(
            Effect.gen(function* () {
              const running = yield* process.launch(config, first ? 0 : pinnedPort);
              const boundPort = yield* running.ready;
              readyAt = yield* Clock.currentTimeMillis;

              const wasFirst = first;
              if (wasFirst) {
                pinnedPort = boundPort;
                first = false;
              }

              yield* setStatus(statusRef, "ready");
              if (wasFirst) {
                yield* Deferred.succeed(initial, {
                  httpBaseUrl: `http://127.0.0.1:${boundPort}`,
                  wsBaseUrl: `ws://127.0.0.1:${boundPort}`,
                  token: options.token,
                });
              }
              return yield* running.awaitExit;
            }),
          ).pipe(Effect.result);

          if (first && Result.isFailure(attempt)) {
            yield* Deferred.fail(initial, attempt.failure);
            return;
          }

          const now = yield* Clock.currentTimeMillis;
          const uptime = readyAt === undefined ? 0 : now - readyAt;
          if (uptime >= stableAfter) fastFailures = 0;
          fastFailures += 1;

          if (Result.isFailure(attempt)) {
            yield* Effect.logWarning("Backend process attempt failed").pipe(
              Effect.annotateLogs({ error: String(attempt.failure) }),
            );
          }

          if (fastFailures > maxFailures) {
            yield* setStatus(statusRef, "failed");
            yield* Queue.take(retryQueue);
            fastFailures = 0;
            yield* setStatus(statusRef, "reconnecting");
            continue;
          }

          yield* setStatus(statusRef, "reconnecting");
          yield* Effect.sleep(restartBackoff(fastFailures, initialDelay, maxDelay));
        }
      });

      yield* supervise.pipe(Effect.forkScoped);
      const connection = yield* Deferred.await(initial);

      const snapshot = SubscriptionRef.get(statusRef);
      return BackendSupervisor.of({
        connection,
        snapshot,
        status: snapshot.pipe(Effect.map((current) => current.status)),
        changes: SubscriptionRef.changes(statusRef),
        retry: Effect.gen(function* () {
          const current = yield* snapshot;
          if (current.status === "failed") yield* Queue.offer(retryQueue, undefined);
        }),
      });
    }),
  );
}
