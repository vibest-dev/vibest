import path from "node:path";
import { fileURLToPath } from "node:url";

import { is } from "@electron-toolkit/utils";
import { Context, Effect, Layer } from "effect";
import { BrowserWindow, shell } from "electron";

import icon from "../../resources/icon.png?asset";
import { APP_ORIGIN } from "./protocol";

export class WindowManager extends Context.Service<
  WindowManager,
  {
    readonly ensureOpen: Effect.Effect<void>;
    readonly focus: Effect.Effect<void>;
  }
>()("desktop/WindowManager") {}

export type WindowManagerOptions = {
  readonly devUrl: string | undefined;
};

function canOpenExternal(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

export function makeWindowManagerLayer(options: WindowManagerOptions): Layer.Layer<WindowManager> {
  return Layer.effect(
    WindowManager,
    Effect.gen(function* () {
      let mainWindow: BrowserWindow | undefined;

      const createWindow = (): void => {
        const window = new BrowserWindow({
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
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
          },
        });
        mainWindow = window;

        window.on("ready-to-show", () => window.show());
        window.on("closed", () => {
          if (mainWindow === window) mainWindow = undefined;
        });

        window.webContents.setWindowOpenHandler(({ url }) => {
          if (canOpenExternal(url)) void shell.openExternal(url);
          return { action: "deny" };
        });

        const allowedOrigins = new Set([
          APP_ORIGIN,
          ...(options.devUrl ? [new URL(options.devUrl).origin] : []),
        ]);
        window.webContents.on("will-navigate", (event, url) => {
          try {
            if (allowedOrigins.has(new URL(url).origin)) return;
          } catch {
            // Invalid navigation targets are denied below.
          }
          event.preventDefault();
        });

        const target = is.dev && options.devUrl ? options.devUrl : `${APP_ORIGIN}/`;
        void window.loadURL(target).catch((error: unknown) => {
          console.error("Failed to load the desktop renderer", error);
        });
      };

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          mainWindow?.destroy();
          mainWindow = undefined;
        }),
      );

      return WindowManager.of({
        ensureOpen: Effect.sync(() => {
          if (!mainWindow || mainWindow.isDestroyed()) createWindow();
        }),
        focus: Effect.sync(() => {
          const window = mainWindow;
          if (!window || window.isDestroyed()) return;
          if (window.isMinimized()) window.restore();
          window.focus();
        }),
      });
    }),
  );
}

export function rendererRoot(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "../renderer");
}
