import path from "node:path";
import { fileURLToPath } from "node:url";

import { electronApp, optimizer } from "@electron-toolkit/utils";
import { app, BrowserWindow, shell } from "electron";

import icon from "../../resources/icon.png?asset";

function createWindow(): void {
  const mainWindow = new BrowserWindow({
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
      // .js, not .mjs: a sandboxed preload must be CommonJS — Electron does not
      // support ESM preloads in a sandboxed renderer. Step 5 configures
      // electron-vite to emit it that way.
      preload: path.join(path.dirname(fileURLToPath(import.meta.url)), "../preload/index.js"),
      // Nothing in the renderer needs Node any more — the backend is a separate
      // process, reached over HTTP.
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.on("ready-to-show", () => {
    mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: "deny" };
  });
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId("com.vibest.desktop");

  app.on("browser-window-created", (_, window) => {
    optimizer.watchWindowShortcuts(window);
  });

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
