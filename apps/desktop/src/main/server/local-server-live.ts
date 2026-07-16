import { Effect, Layer } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { DesktopConfig } from "../desktop-config";
import { LocalServer, makeLocalServer } from "./local-server";
import { resolveLoginShellEnvironmentWith } from "./login-shell-environment";
import { makeNodeServerProcess } from "./node-server-process";

export const LocalServerLive = Layer.effect(
  LocalServer,
  Effect.gen(function* () {
    const config = yield* DesktopConfig;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const environment = config.isPackaged
      ? resolveLoginShellEnvironmentWith(spawner)
      : Effect.sync(() => ({ ...process.env }));

    return yield* makeLocalServer(
      {
        entry: config.serverEntry,
        token: config.token,
        environment,
        corsOrigins: config.allowedOrigins,
      },
      makeNodeServerProcess(spawner),
    );
  }),
);
