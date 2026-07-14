import { electronApp, is, optimizer } from "@electron-toolkit/utils";
import { Effect, ManagedRuntime } from "effect";
import { app, dialog } from "electron";

import { makeBackendToken, resolveServerEntry } from "./backend";
import { makeDesktopMainLayer, type DesktopMainServices } from "./main-layer";
import { APP_ORIGIN, registerAppScheme } from "./protocol";
import { WindowManager, rendererRoot } from "./window-manager";

let runtime: ManagedRuntime.ManagedRuntime<DesktopMainServices, unknown> | undefined;
let disposing = false;
let allowQuit = false;

function runWindowAction(action: (windows: WindowManager["Service"]) => Effect.Effect<void>): void {
  runtime?.runFork(
    Effect.gen(function* () {
      const windows = yield* WindowManager;
      yield* action(windows);
    }),
  );
}

async function disposeAndQuit(): Promise<void> {
  if (disposing) return;
  disposing = true;
  try {
    await runtime?.dispose();
  } finally {
    runtime = undefined;
    allowQuit = true;
    app.quit();
  }
}

async function startPrimaryInstance(): Promise<void> {
  await app.whenReady();

  electronApp.setAppUserModelId("com.vibest.desktop");
  app.on("browser-window-created", (_, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  const devUrl = is.dev ? process.env["ELECTRON_RENDERER_URL"] : undefined;
  const allowedOrigins = [APP_ORIGIN, ...(devUrl ? [new URL(devUrl).origin] : [])];

  const layer = makeDesktopMainLayer({
    backend: {
      entry: resolveServerEntry(app.isPackaged, process.resourcesPath),
      token: makeBackendToken(),
      corsOrigins: allowedOrigins,
      useLoginShellPath: app.isPackaged,
    },
    rendererRoot: rendererRoot(),
    devUrl,
    allowedOrigins,
  });

  runtime = ManagedRuntime.make(layer);

  try {
    await runtime.runPromise(runtime.contextEffect);
    await runtime.runPromise(
      Effect.gen(function* () {
        const windows = yield* WindowManager;
        yield* windows.ensureOpen;
      }),
    );
  } catch (error) {
    dialog.showErrorBox(
      "Vibest could not start",
      `The local server failed to start.\n\n${error instanceof Error ? error.message : String(error)}`,
    );
    await disposeAndQuit();
  }
}

if (!app.requestSingleInstanceLock()) {
  allowQuit = true;
  app.quit();
} else {
  // Electron only accepts privileged scheme registration before ready.
  registerAppScheme();

  app.on("second-instance", () => runWindowAction((windows) => windows.focus));
  app.on("activate", () => runWindowAction((windows) => windows.ensureOpen));

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
