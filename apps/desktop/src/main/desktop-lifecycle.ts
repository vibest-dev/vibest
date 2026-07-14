import { Context, Effect, Layer } from "effect";
import { app } from "electron";

export class DesktopLifecycle extends Context.Service<
  DesktopLifecycle,
  { readonly requestQuit: Effect.Effect<void> }
>()("desktop/DesktopLifecycle") {}

export const DesktopLifecycleLive = Layer.succeed(
  DesktopLifecycle,
  DesktopLifecycle.of({
    requestQuit: Effect.sync(() => {
      setTimeout(() => app.quit(), 0);
    }),
  }),
);
