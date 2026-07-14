import { Effect, Option, Stream } from "effect";

import type { BackendStatusSnapshot, DesktopBootstrap } from "../../shared/desktop-rpc";
import type { LocalBackend } from "../backend/local-backend";

const STATUS_POLL_TIMEOUT = "20 seconds";

export interface DesktopApplication {
  readonly bootstrap: Effect.Effect<DesktopBootstrap>;
  readonly waitForBackendStatus: (after: number) => Effect.Effect<BackendStatusSnapshot>;
  readonly retryBackend: Effect.Effect<void>;
  readonly quit: Effect.Effect<void>;
}

export type DesktopApplicationDependencies = {
  readonly backend: LocalBackend;
  readonly os: NodeJS.Platform;
  readonly quit: Effect.Effect<void>;
};

export function makeDesktopApplication({
  backend,
  os,
  quit,
}: DesktopApplicationDependencies): DesktopApplication {
  return {
    bootstrap: Effect.gen(function* () {
      const current = yield* backend.snapshot;
      return {
        os,
        backend: backend.connection,
        status: current.status,
        statusRevision: current.revision,
      };
    }),
    waitForBackendStatus: (after) =>
      Effect.gen(function* () {
        const current = yield* backend.snapshot;
        if (current.revision > after) return current;

        const changed = yield* backend.changes.pipe(
          Stream.filter((next) => next.revision > after),
          Stream.runHead,
          Effect.timeoutOrElse({
            duration: STATUS_POLL_TIMEOUT,
            orElse: () => Effect.succeed(Option.none()),
          }),
        );
        return Option.getOrElse(changed, () => current);
      }),
    retryBackend: backend.retry,
    quit,
  };
}
