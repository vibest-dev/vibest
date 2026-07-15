import path from "node:path";
import { fileURLToPath } from "node:url";

import { is } from "@electron-toolkit/utils";
import { Context, Effect, Layer, Scope } from "effect";
import { BrowserWindow, shell, type WebContents } from "electron";

import icon from "../../../resources/icon.png?asset";
import { DesktopConfig } from "../desktop-config";
import { APP_ORIGIN, registerAppProtocol } from "./app-protocol";
import { RendererChannel } from "./renderer-channel";

export class MainWindow extends Context.Service<
  MainWindow,
  {
    readonly ensureOpen: Effect.Effect<void>;
    readonly focus: Effect.Effect<void>;
  }
>()("desktop/MainWindow") {}

export type MainWindowOptions = {
  readonly devUrl: string | undefined;
  readonly connectRenderer: (webContents: WebContents) => () => Promise<void>;
};

function canOpenExternal(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

export function makeMainWindow(
  options: MainWindowOptions,
): Effect.Effect<MainWindow["Service"], never, Scope.Scope> {
  return Effect.gen(function* () {
    let mainWindow: BrowserWindow | undefined;
    let disconnectRenderer: (() => Promise<void>) | undefined;

    const disconnectCurrentRenderer = (): void => {
      const disconnect = disconnectRenderer;
      disconnectRenderer = undefined;
      if (disconnect) void disconnect();
    };

    const target = is.dev && options.devUrl ? options.devUrl : `${APP_ORIGIN}/`;

    const createWindow = (): BrowserWindow => {
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
          preload: path.join(path.dirname(fileURLToPath(import.meta.url)), "../preload/index.js"),
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      mainWindow = window;

      window.on("ready-to-show", () => window.show());
      window.webContents.on("did-finish-load", () => {
        disconnectCurrentRenderer();
        disconnectRenderer = options.connectRenderer(window.webContents);
      });
      window.on("closed", () => {
        disconnectCurrentRenderer();
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

      return window;
    };

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        disconnectCurrentRenderer();
        mainWindow?.destroy();
        mainWindow = undefined;
      }),
    );

    // Detached so ensureOpen stays fire-and-forget; the load outcome is only
    // observed for logging.
    const loadRenderer = (window: BrowserWindow) =>
      Effect.tryPromise(() => window.loadURL(target)).pipe(
        Effect.catchCause((cause) => Effect.logError("Failed to load the desktop renderer", cause)),
        Effect.forkDetach,
      );

    return {
      ensureOpen: Effect.gen(function* () {
        if (mainWindow && !mainWindow.isDestroyed()) return;
        yield* loadRenderer(createWindow());
      }),
      focus: Effect.sync(() => {
        const window = mainWindow;
        if (!window || window.isDestroyed()) return;
        if (window.isMinimized()) window.restore();
        window.focus();
      }),
    } satisfies MainWindow["Service"];
  });
}

export function rendererRoot(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "../renderer");
}

export const MainWindowLive = Layer.effect(
  MainWindow,
  Effect.gen(function* () {
    const config = yield* DesktopConfig;
    const channel = yield* RendererChannel;
    yield* registerAppProtocol(rendererRoot());
    return yield* makeMainWindow({
      devUrl: config.devUrl,
      connectRenderer: channel.connect,
    });
  }),
);
