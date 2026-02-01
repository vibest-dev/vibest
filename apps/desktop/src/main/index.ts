import { electronApp, is, optimizer } from "@electron-toolkit/utils";
import { app, BrowserWindow, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

import icon from "../../resources/icon.png?asset";
import { App } from "./app";
import { setupIPC } from "./ipc";

let mainApp: App | null = null;

function createWindow(appInstance: App): void {
  // Create the browser window.
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
      preload: path.join(path.dirname(fileURLToPath(import.meta.url)), "../preload/index.mjs"),
      sandbox: false,
      contextIsolation: true,
    },
  });

  mainWindow.on("ready-to-show", () => {
    mainWindow.show();
  });

  // Refresh git watchers when window gains focus
  mainWindow.on("focus", () => {
    appInstance.gitWatcher.refreshByGroup("git");
  });

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: "deny" };
  });

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    mainWindow.loadFile(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "../renderer/index.html"),
    );
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(async () => {
  // Set app user model id for windows
  electronApp.setAppUserModelId("com.vibest.desktop");

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on("browser-window-created", (_, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  // Initialize the App instance
  mainApp = new App();
  await mainApp.start();

  // Setup IPC handlers with App instance
  setupIPC(mainApp);

  createWindow(mainApp);

  app.on("activate", () => {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0 && mainApp) createWindow(mainApp);
  });
});

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", async () => {
  if (mainApp) {
    await mainApp.stop();
  }
});

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
