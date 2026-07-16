import { Context, Effect, Stream } from "effect";

import type {
  ServerConnection,
  ServerStatusSnapshot,
  DesktopBootstrap,
} from "../../shared/desktop-rpc";
import type { LocalServer } from "../server/local-server";

export class DesktopApplication extends Context.Service<
  DesktopApplication,
  {
    readonly bootstrap: Effect.Effect<DesktopBootstrap>;
    readonly serverConnection: Effect.Effect<ServerConnection>;
    readonly watchServerStatus: (after: number) => Stream.Stream<ServerStatusSnapshot>;
    readonly retryServer: Effect.Effect<void>;
    readonly quit: Effect.Effect<void>;
  }
>()("desktop/DesktopApplication") {}

export type DesktopApplicationDependencies = {
  readonly server: LocalServer["Service"];
  readonly quit: Effect.Effect<void>;
};

export function makeDesktopApplication({
  server,
  quit,
}: DesktopApplicationDependencies): DesktopApplication["Service"] {
  return {
    bootstrap: Effect.gen(function* () {
      const current = yield* server.snapshot;
      return {
        status: current.status,
        statusRevision: current.revision,
      };
    }),
    serverConnection: server.connection,
    // v4 SubscriptionRef.changes replays the latest snapshot on subscribe
    // (PubSub replay: 1), so the stream always starts from the current status.
    watchServerStatus: (after) =>
      server.changes.pipe(Stream.filter((snapshot) => snapshot.revision > after)),
    retryServer: server.retry,
    quit,
  } satisfies DesktopApplication["Service"];
}
