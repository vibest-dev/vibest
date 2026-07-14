import "@orpc/experimental-effect/extensions/effect";
import type { WithEffectContext } from "@orpc/experimental-effect";
import { implement, streamToAsyncIteratorObject } from "@orpc/server";
import { Effect, Stream } from "effect";

import { desktopContract } from "../../shared/desktop-rpc";
import type { DesktopApplication } from "../application/desktop-application";

export type DesktopRpcContext = WithEffectContext<never>;

export function makeDesktopRouter(application: DesktopApplication) {
  const orpc = implement(desktopContract).$context<DesktopRpcContext>();

  return orpc.router({
    bootstrap: orpc.bootstrap.effect(function* () {
      return yield* application.bootstrap;
    }),
    status: {
      subscribe: orpc.status.subscribe.effect(function* ({ input }) {
        return yield* Effect.sync(() =>
          streamToAsyncIteratorObject(
            Stream.toReadableStream(application.watchBackendStatus(input.after)),
          ),
        );
      }),
    },
    backend: {
      retry: orpc.backend.retry.effect(function* () {
        yield* application.retryBackend;
      }),
    },
    app: {
      quit: orpc.app.quit.effect(function* () {
        yield* application.quit;
      }),
    },
  });
}

export type DesktopRouter = ReturnType<typeof makeDesktopRouter>;

export async function logDesktopRpcErrors<T>({ next }: { next: () => Promise<T> }): Promise<T> {
  try {
    return await next();
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "AbortError")) {
      console.error("[desktop-rpc]", error);
    }
    throw error;
  }
}
