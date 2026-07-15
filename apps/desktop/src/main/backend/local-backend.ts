import {
  Clock,
  Data,
  Deferred,
  Effect,
  Queue,
  Result,
  Scope,
  Stream,
  SubscriptionRef,
} from "effect";

import type {
  BackendConnection,
  BackendStatus,
  BackendStatusSnapshot,
} from "../../shared/desktop-rpc";

const DEFAULTS = {
  initialRestartDelayMs: 500,
  maxRestartDelayMs: 10_000,
  maxFastFailures: 5,
  stableAfterMs: 10_000,
};

export class BackendSpawnError extends Data.TaggedError("BackendSpawnError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class BackendReadyTimeout extends Data.TaggedError("BackendReadyTimeout")<{
  readonly timeoutMs: number;
  readonly message: string;
}> {}

export class BackendExitedBeforeReady extends Data.TaggedError("BackendExitedBeforeReady")<{
  readonly exitCode: number | null;
  readonly message: string;
}> {}

export type BackendStartError = BackendSpawnError | BackendReadyTimeout | BackendExitedBeforeReady;

export type BackendProcessConfig = {
  readonly entry: string;
  readonly token: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly corsOrigins: readonly string[];
};

export type BackendProcessExit = {
  readonly exitCode: number | null;
};

export type RunningBackendProcess = {
  readonly ready: Effect.Effect<number, BackendStartError>;
  readonly awaitExit: Effect.Effect<BackendProcessExit, BackendSpawnError>;
};

export type SpawnBackend = (
  config: BackendProcessConfig,
  port: number,
) => Effect.Effect<RunningBackendProcess, BackendSpawnError, Scope.Scope>;

export type LocalBackendConfig = BackendProcessConfig & {
  readonly initialRestartDelayMs?: number;
  readonly maxRestartDelayMs?: number;
  readonly maxFastFailures?: number;
  readonly stableAfterMs?: number;
};

export interface LocalBackend {
  readonly connection: BackendConnection;
  readonly snapshot: Effect.Effect<BackendStatusSnapshot>;
  readonly changes: Stream.Stream<BackendStatusSnapshot>;
  readonly retry: Effect.Effect<void>;
}

export function restartBackoff(
  failureCount: number,
  initialDelayMs = DEFAULTS.initialRestartDelayMs,
  maxDelayMs = DEFAULTS.maxRestartDelayMs,
): number {
  return Math.min(initialDelayMs * 2 ** (failureCount - 1), maxDelayMs);
}

// The supervise fiber is the only writer of statusRef, so get→set is
// race-free. Not SubscriptionRef.modify: v4's set/modify publish
// unconditionally, which would replay no-op snapshots to subscribers.
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

export function makeLocalBackend(
  config: LocalBackendConfig,
  spawnBackend: SpawnBackend,
): Effect.Effect<LocalBackend, BackendStartError, Scope.Scope> {
  return Effect.gen(function* () {
    const statusRef = yield* SubscriptionRef.make<BackendStatusSnapshot>({
      revision: 0,
      status: "starting",
    });
    const retryQueue = yield* Queue.dropping<void>(1);
    const initial = yield* Deferred.make<BackendConnection, BackendStartError>();

    const initialDelay = config.initialRestartDelayMs ?? DEFAULTS.initialRestartDelayMs;
    const maxDelay = config.maxRestartDelayMs ?? DEFAULTS.maxRestartDelayMs;
    const maxFailures = config.maxFastFailures ?? DEFAULTS.maxFastFailures;
    const stableAfter = config.stableAfterMs ?? DEFAULTS.stableAfterMs;

    const supervise = Effect.gen(function* () {
      let first = true;
      let pinnedPort = 0;
      let fastFailures = 0;

      while (true) {
        let readyAt: number | undefined;

        const attempt = yield* Effect.scoped(
          Effect.gen(function* () {
            const running = yield* spawnBackend(config, first ? 0 : pinnedPort);
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
                token: config.token,
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

    return {
      connection,
      snapshot,
      changes: SubscriptionRef.changes(statusRef),
      retry: Effect.gen(function* () {
        const current = yield* snapshot;
        if (current.status === "failed") yield* Queue.offer(retryQueue, undefined);
      }),
    } satisfies LocalBackend;
  });
}
