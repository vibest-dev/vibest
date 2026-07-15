import { Context, Effect, Stream } from "effect";

import type { BackendStatusSnapshot, DesktopBootstrap } from "../../shared/desktop-rpc";
import type { LocalBackend } from "../backend/local-backend";

export class DesktopApplication extends Context.Service<
  DesktopApplication,
  {
    readonly bootstrap: Effect.Effect<DesktopBootstrap>;
    readonly watchBackendStatus: (after: number) => Stream.Stream<BackendStatusSnapshot>;
    readonly retryBackend: Effect.Effect<void>;
    readonly quit: Effect.Effect<void>;
  }
>()("desktop/DesktopApplication") {}

export type DesktopApplicationDependencies = {
  readonly backend: LocalBackend["Service"];
  readonly os: NodeJS.Platform;
  readonly quit: Effect.Effect<void>;
};

export function makeDesktopApplication({
  backend,
  os,
  quit,
}: DesktopApplicationDependencies): DesktopApplication["Service"] {
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
    // v4 SubscriptionRef.changes replays the latest snapshot on subscribe
    // (PubSub replay: 1), so the stream always starts from the current status.
    watchBackendStatus: (after) =>
      backend.changes.pipe(Stream.filter((snapshot) => snapshot.revision > after)),
    retryBackend: backend.retry,
    quit,
  } satisfies DesktopApplication["Service"];
}
