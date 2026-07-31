import path from "node:path";
import url from "node:url";

import { is } from "@electron-toolkit/utils";
import { Context, Effect, Layer, Scope } from "effect";
import { BrowserWindow, shell } from "electron";

import icon from "../../../resources/icon.png?asset";
import { DesktopConfig } from "../desktop-config";
import { APP_ORIGIN, registerAppProtocol } from "./app-protocol";
import { RendererChannel } from "./renderer-channel";
import { type ConnectRenderer, makeRendererLifecycle } from "./renderer-lifecycle";

export class MainWindow extends Context.Service<
  MainWindow,
  {
    readonly ensureOpen: Effect.Effect<void>;
    readonly focus: Effect.Effect<void>;
  }
>()("desktop/MainWindow") {}

export type MainWindowOptions = {
  readonly devUrl: string | undefined;
  readonly connectRenderer: ConnectRenderer;
};

function canOpenExternal(href: string): boolean {
  try {
    const protocol = new URL(href).protocol;
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
    const isE2E = process.env["VIBEST_E2E"] === "1";

    const renderer = yield* makeRendererLifecycle(options.connectRenderer);
    // Electron event callbacks are synchronous, so lifecycle transitions run
    // on forked fibers carrying this Layer's context (for the logger). The
    // lifecycle serializes them internally, and the shutdown finalizer below
    // refuses late attachments, so a straggling fiber cannot attach a peer
    // after disposal.
    const context = yield* Effect.context<never>();
    const forkRendererTransition = (transition: Effect.Effect<void>): void => {
      Effect.runFork(Effect.provideContext(transition, context));
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
        // y=20 centers the ~14px traffic lights on the header row (see __root.tsx).
        trafficLightPosition: { x: 22, y: 20 },
        ...(process.platform === "linux" ? { icon } : {}),
        webPreferences: {
          preload: path.join(
            path.dirname(url.fileURLToPath(import.meta.url)),
            "../preload/index.js",
          ),
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          backgroundThrottling: !isE2E,
        },
      });
      mainWindow = window;

      window.on("ready-to-show", () => {
        if (!isE2E) window.show();
      });
      window.webContents.on("did-finish-load", () => {
        forkRendererTransition(renderer.replace(window.webContents));
      });
      window.on("closed", () => {
        forkRendererTransition(renderer.detach);
        if (mainWindow === window) mainWindow = undefined;
      });

      window.webContents.setWindowOpenHandler(({ url: href }) => {
        if (canOpenExternal(href)) void shell.openExternal(href);
        return { action: "deny" };
      });

      const allowedOrigins = new Set([
        APP_ORIGIN,
        ...(options.devUrl ? [new URL(options.devUrl).origin] : []),
      ]);
      window.webContents.on("will-navigate", (event, href) => {
        try {
          if (allowedOrigins.has(new URL(href).origin)) return;
        } catch {
          // Invalid navigation targets are denied below.
        }
        event.preventDefault();
      });

      return window;
    };

    yield* Effect.addFinalizer(() =>
      renderer.shutdown.pipe(
        Effect.andThen(
          Effect.sync(() => {
            mainWindow?.destroy();
            mainWindow = undefined;
          }),
        ),
      ),
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
        if (isE2E) return;
        const window = mainWindow;
        if (!window || window.isDestroyed()) return;
        if (window.isMinimized()) window.restore();
        window.focus();
      }),
    } satisfies MainWindow["Service"];
  });
}

export function rendererRoot(): string {
  return path.join(path.dirname(url.fileURLToPath(import.meta.url)), "../renderer");
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
