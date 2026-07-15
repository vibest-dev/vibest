import { Effect, Layer } from "effect";
import { app } from "electron";

import { DesktopApplication, makeDesktopApplication } from "./application/desktop-application";
import { LocalBackend } from "./backend/local-backend";
import { RendererChannel, makeRendererChannel } from "./electron/renderer-channel";
import { makeDesktopRpcServer } from "./rpc/desktop-rpc-server";

// These two Live layers need Electron capabilities (app.quit, and the oRPC
// MessagePort wiring that reaches into application/** and rpc/**) that the
// modules they connect are not allowed to import directly, so they live at
// the composition root instead of alongside their Tag. Split into their own
// file (rather than desktop-runtime.ts itself) so they stay importable from
// tests without pulling in main-window.ts's BrowserWindow dependency.
export const DesktopApplicationLive = Layer.effect(
  DesktopApplication,
  Effect.gen(function* () {
    const backend = yield* LocalBackend;
    return makeDesktopApplication({
      backend,
      os: process.platform,
      quit: Effect.sync(() => {
        setTimeout(() => app.quit(), 0);
      }),
    });
  }),
);

export const RendererChannelLive = Layer.effect(
  RendererChannel,
  Effect.gen(function* () {
    const application = yield* DesktopApplication;
    // Hand the composition root's full ServiceMap (including logger and
    // other references) to the detached oRPC handler fibers.
    const rpcContext = yield* Effect.context<never>();
    return makeRendererChannel(makeDesktopRpcServer(application, rpcContext).attach);
  }),
);
