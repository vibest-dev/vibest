import { Effect, Layer } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { DesktopConfig } from "../desktop-config";
import { makeDaemonServerProcess } from "./daemon-server-process";
import { LocalServer, makeLocalServer } from "./local-server";
import { resolveLoginShellEnvironmentWith } from "./login-shell-environment";

export const LocalServerLive = Layer.effect(
  LocalServer,
  Effect.gen(function* () {
    const config = yield* DesktopConfig;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const environment = config.isPackaged
      ? resolveLoginShellEnvironmentWith(spawner)
      : Effect.sync(() => ({ ...process.env }));

    // Attach the daemon selected by VIBEST_DAEMON_DIR (the same one the CLI
    // uses) instead of forking a private die-with-app child.
    return yield* makeLocalServer(
      {
        entry: config.serverEntry,
        environment,
      },
      yield* makeDaemonServerProcess(),
    );
  }),
);
