import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { Effect, Layer } from "effect";

import { BackendProcessLive } from "./backend";
import { DesktopLifecycle, DesktopLifecycleLive } from "./desktop-lifecycle";
import { createDesktopRpcHandler, type DesktopRpcServices } from "./desktop-rpc";
import { type BackendStartError, DesktopProtocolRegistrationError } from "./errors";
import { registerAppProtocol, unregisterAppProtocol } from "./protocol";
import { LoginShellPathLive } from "./shell-path";
import {
  BackendSupervisor,
  type BackendSupervisorOptions,
  makeBackendSupervisorLayer,
} from "./supervisor";
import { WindowManager, makeWindowManagerLayer } from "./window-manager";

export type DesktopMainOptions = {
  readonly backend: BackendSupervisorOptions;
  readonly rendererRoot: string;
  readonly devUrl: string | undefined;
  readonly allowedOrigins: readonly string[];
};

export type DesktopMainServices = BackendSupervisor | DesktopLifecycle | WindowManager;

export function makeDesktopMainLayer(
  options: DesktopMainOptions,
): Layer.Layer<DesktopMainServices, DesktopProtocolRegistrationError | BackendStartError> {
  const nodeBase = Layer.merge(NodeFileSystem.layer, NodePath.layer);
  const childProcess = NodeChildProcessSpawner.layer.pipe(Layer.provide(nodeBase));
  const processServices = Layer.merge(BackendProcessLive, LoginShellPathLive).pipe(
    Layer.provide(childProcess),
  );
  const supervisor = makeBackendSupervisorLayer(options.backend).pipe(
    Layer.provide(processServices),
  );
  const core = Layer.mergeAll(
    supervisor,
    DesktopLifecycleLive,
    makeWindowManagerLayer({ devUrl: options.devUrl }),
  );

  const appProtocol = Layer.effectDiscard(
    Effect.gen(function* () {
      const effectContext = yield* Effect.context<DesktopRpcServices>();
      const rpc = createDesktopRpcHandler(effectContext, options.allowedOrigins);

      yield* Effect.acquireRelease(
        Effect.try({
          try: () => registerAppProtocol(options.rendererRoot, rpc),
          catch: (cause) =>
            new DesktopProtocolRegistrationError({
              message: "Unable to register the vibest protocol",
              cause,
            }),
        }),
        () =>
          Effect.sync(() => {
            try {
              unregisterAppProtocol();
            } catch {
              // Electron may already have torn protocol handling down during exit.
            }
          }),
      );
    }),
  ).pipe(Layer.provide(core));

  return Layer.merge(core, appProtocol);
}
