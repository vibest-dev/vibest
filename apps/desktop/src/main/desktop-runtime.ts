import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { electronApp, is, optimizer } from "@electron-toolkit/utils";
import { Context, Effect, Layer, ManagedRuntime, Result } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { app, dialog } from "electron";

import { makeDesktopApplication } from "./application/desktop-application";
import { makeLocalBackend } from "./backend/local-backend";
import { resolveLoginShellEnvironmentWith } from "./backend/login-shell-environment";
import { makeNodeBackendProcess } from "./backend/node-backend-process";
import { APP_ORIGIN, registerAppProtocol, registerAppScheme } from "./electron/app-protocol";
import { makeMainWindow, rendererRoot } from "./electron/main-window";
import { makeRendererChannel } from "./electron/renderer-channel";
import { makeDesktopRpcServer } from "./rpc/desktop-rpc-server";
import { formatStartupFailure } from "./startup-failure";

class DesktopRuntime extends Context.Service<
  DesktopRuntime,
  {
    readonly ensureWindow: Effect.Effect<void>;
    readonly focusWindow: Effect.Effect<void>;
  }
>()("desktop/DesktopRuntime") {}

function resolveServerEntry(isPackaged: boolean, resourcesPath: string): string {
  if (isPackaged) {
    return path.join(
      resourcesPath,
      "app.asar",
      "node_modules",
      "@vibest",
      "cli",
      "dist",
      "cli.mjs",
    );
  }
  return fileURLToPath(new URL("../../../../packages/vibest/dist/cli.mjs", import.meta.url));
}

function makeDesktopRuntimeLayer(devUrl: string | undefined) {
  return Layer.effect(
    DesktopRuntime,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const allowedOrigins = [APP_ORIGIN, ...(devUrl ? [new URL(devUrl).origin] : [])];
      const environment = app.isPackaged
        ? yield* resolveLoginShellEnvironmentWith(spawner)
        : { ...process.env };

      const backend = yield* makeLocalBackend(
        {
          entry: resolveServerEntry(app.isPackaged, process.resourcesPath),
          token: randomUUID(),
          environment,
          corsOrigins: allowedOrigins,
        },
        makeNodeBackendProcess(spawner),
      );

      const application = makeDesktopApplication({
        backend,
        os: process.platform,
        quit: Effect.sync(() => {
          setTimeout(() => app.quit(), 0);
        }),
      });
      // Hand the composition root's full ServiceMap (including logger and
      // other references) to the detached oRPC handler fibers.
      const rpcContext = yield* Effect.context<never>();
      const rpcServer = makeDesktopRpcServer(application, rpcContext);
      const rendererChannel = makeRendererChannel(rpcServer.attach);

      yield* registerAppProtocol(rendererRoot());
      const mainWindow = yield* makeMainWindow({
        devUrl,
        connectRenderer: rendererChannel.connect,
      });

      return DesktopRuntime.of({
        ensureWindow: mainWindow.ensureOpen,
        focusWindow: mainWindow.focus,
      });
    }),
  );
}

function makeRuntime(devUrl: string | undefined) {
  const nodeBase = Layer.merge(NodeFileSystem.layer, NodePath.layer);
  const childProcess = NodeChildProcessSpawner.layer.pipe(Layer.provide(nodeBase));
  return ManagedRuntime.make(makeDesktopRuntimeLayer(devUrl).pipe(Layer.provide(childProcess)));
}

export function startDesktopRuntime(): void {
  let runtime: ReturnType<typeof makeRuntime> | undefined;
  let disposing = false;
  let allowQuit = false;

  const runWindowAction = (
    action: (desktop: DesktopRuntime["Service"]) => Effect.Effect<void>,
  ): void => {
    runtime?.runFork(
      Effect.gen(function* () {
        const desktop = yield* DesktopRuntime;
        yield* action(desktop);
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
          const desktop = yield* DesktopRuntime;
          yield* desktop.ensureWindow;
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

  app.on("second-instance", () => runWindowAction((desktop) => desktop.focusWindow));
  app.on("activate", () => runWindowAction((desktop) => desktop.ensureWindow));

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
