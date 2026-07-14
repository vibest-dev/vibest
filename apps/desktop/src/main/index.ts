import path from "node:path";
import { fileURLToPath } from "node:url";

import { electronApp, is, optimizer } from "@electron-toolkit/utils";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";

import icon from "../../resources/icon.png?asset";
import { type Backend, startBackend } from "./backend";
import { APP_ORIGIN, registerAppProtocol, registerAppScheme } from "./protocol";

let backend: Backend | undefined;
let mainWindow: BrowserWindow | undefined;

// Two launches would spawn two backends, each on its own port, each with its
// own agent — so the second launch focuses the first window instead.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

// Must precede app.whenReady().
registerAppScheme();

function rendererRoot(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "../renderer");
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 16 },
    ...(process.platform === "linux" ? { icon } : {}),
    webPreferences: {
      // .js, not .mjs: a sandboxed preload must be CommonJS.
      preload: path.join(path.dirname(fileURLToPath(import.meta.url)), "../preload/index.js"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.on("ready-to-show", () => {
    mainWindow?.show();
  });

  mainWindow.on("closed", () => {
    mainWindow = undefined;
  });

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: "deny" };
  });

  const devUrl = process.env["ELECTRON_RENDERER_URL"];
  if (is.dev && devUrl) {
    void mainWindow.loadURL(devUrl);
  } else {
    // Load the origin root, not /index.html: the router matches on pathname, and
    // "/index.html" matches no route (it renders Not Found). The protocol
    // handler's SPA fallback serves index.html for "/" anyway.
    void mainWindow.loadURL(`${APP_ORIGIN}/`);
  }
}

app.on("second-instance", () => {
  const [existing] = BrowserWindow.getAllWindows();
  if (!existing) return;
  if (existing.isMinimized()) existing.restore();
  existing.focus();
});

app.whenReady().then(async () => {
  electronApp.setAppUserModelId("com.vibest.desktop");

  app.on("browser-window-created", (_, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  // In dev the renderer is served by Vite over http, so that origin must be
  // allowed too; in production it is only ever the app protocol.
  const devUrl = process.env["ELECTRON_RENDERER_URL"];
  const corsOrigins = [APP_ORIGIN, ...(is.dev && devUrl ? [new URL(devUrl).origin] : [])];

  try {
    backend = await startBackend({ corsOrigins });
  } catch (error) {
    dialog.showErrorBox(
      "Vibest could not start",
      `The local server failed to start.\n\n${(error as Error).message}`,
    );
    app.quit();
    return;
  }

  // The preload asks for this before the renderer's first module runs.
  ipcMain.on("vibest:bootstrap", (event) => {
    event.returnValue = backend
      ? {
          httpBaseUrl: backend.httpBaseUrl,
          wsBaseUrl: backend.wsBaseUrl,
          token: backend.token,
          status: backend.status(),
        }
      : null;
  });

  // Push each supervisor transition to the renderer, which reflects it as the
  // reconnecting overlay (or a terminal failed state).
  backend.onStatusChange((status) => {
    mainWindow?.webContents.send("vibest:backend-status", status);
  });

  // The overlay's controls: "Retry" from the failed state, and "Quit".
  ipcMain.on("vibest:retry", () => backend?.retry());
  ipcMain.on("vibest:quit", () => app.quit());

  registerAppProtocol(rendererRoot());

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  backend?.stop();
  backend = undefined;
});
