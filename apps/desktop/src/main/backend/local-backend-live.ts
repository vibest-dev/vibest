import { Effect, Layer } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { DesktopConfig } from "../desktop-config";
import { LocalBackend, makeLocalBackend } from "./local-backend";
import { resolveLoginShellEnvironmentWith } from "./login-shell-environment";
import { makeNodeBackendProcess } from "./node-backend-process";

export const LocalBackendLive = Layer.effect(
  LocalBackend,
  Effect.gen(function* () {
    const config = yield* DesktopConfig;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const environment = config.isPackaged
      ? yield* resolveLoginShellEnvironmentWith(spawner)
      : { ...process.env };

    return yield* makeLocalBackend(
      {
        entry: config.serverEntry,
        token: config.token,
        environment,
        corsOrigins: config.allowedOrigins,
      },
      makeNodeBackendProcess(spawner),
    );
  }),
);
