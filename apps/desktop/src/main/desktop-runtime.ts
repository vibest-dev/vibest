import { randomUUID } from "node:crypto";

import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { electronApp, is, optimizer } from "@electron-toolkit/utils";
import { Effect, Layer, ManagedRuntime, Result } from "effect";
import { app, dialog } from "electron";

import { makeDesktopConfigLive } from "./desktop-config";
import { DesktopApplicationLive, RendererChannelLive } from "./desktop-runtime-glue";
import { registerAppScheme } from "./electron/app-protocol";
import { MainWindow, MainWindowLive } from "./electron/main-window";
import { LocalServerLive } from "./server/local-server-live";
import { formatStartupFailure } from "./startup-failure";

function makeRuntime(devUrl: string | undefined) {
  const nodeBase = Layer.merge(NodeFileSystem.layer, NodePath.layer);
  const ChildProcessSpawnerLive = NodeChildProcessSpawner.layer.pipe(Layer.provide(nodeBase));
  const DesktopConfigLive = makeDesktopConfigLive({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    devUrl,
    token: randomUUID(),
  });

  return ManagedRuntime.make(
    MainWindowLive.pipe(
      Layer.provide(RendererChannelLive),
      Layer.provide(DesktopApplicationLive),
      Layer.provide(LocalServerLive),
      Layer.provide(DesktopConfigLive),
      Layer.provide(ChildProcessSpawnerLive),
    ),
  );
}

export function startDesktopRuntime(): void {
  const isE2E = process.env["VIBEST_E2E"] === "1";
  if (isE2E && process.platform === "darwin") app.setActivationPolicy("accessory");

  let runtime: ReturnType<typeof makeRuntime> | undefined;
  let disposing = false;
  let allowQuit = false;

  const runWindowAction = (
    action: (window: MainWindow["Service"]) => Effect.Effect<void>,
  ): void => {
    runtime?.runFork(
      Effect.gen(function* () {
        const window = yield* MainWindow;
        yield* action(window);
      }),
    );
  };

  const disposeAndQuit = async (): Promise<void> => {
    if (disposing) return;
    disposing = true;
    try {
      await runtime?.dispose();
    } finally {
      runtime = undefined;
      allowQuit = true;
      app.quit();
    }
  };

  const startPrimaryInstance = async (): Promise<void> => {
    await app.whenReady();

    electronApp.setAppUserModelId("com.vibest.desktop");
    app.on("browser-window-created", (_, window) => {
      optimizer.watchWindowShortcuts(window);
    });

    const devUrl = is.dev ? process.env["ELECTRON_RENDERER_URL"] : undefined;
    runtime = makeRuntime(devUrl);

    try {
      const startup = await runtime.runPromise(Effect.result(runtime.contextEffect));
      if (Result.isFailure(startup)) {
        dialog.showErrorBox("Vibest could not start", formatStartupFailure(startup.failure));
        await disposeAndQuit();
        return;
      }
      await runtime.runPromise(
        Effect.gen(function* () {
          const window = yield* MainWindow;
          yield* window.ensureOpen;
        }),
      );
    } catch (error) {
      // Typed startup failures are handled above; this only catches defects.
      dialog.showErrorBox(
        "Vibest could not start",
        error instanceof Error ? error.message : String(error),
      );
      await disposeAndQuit();
    }
  };

  if (!app.requestSingleInstanceLock()) {
    allowQuit = true;
    app.quit();
    return;
  }

  // Electron only accepts privileged scheme registration before ready.
  registerAppScheme();

  app.on("second-instance", () => runWindowAction((window) => window.focus));
  app.on("activate", () => runWindowAction((window) => window.ensureOpen));

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", (event) => {
    if (allowQuit || !runtime) return;
    event.preventDefault();
    void disposeAndQuit();
  });

  void startPrimaryInstance();
}
