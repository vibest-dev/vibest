import "@orpc/experimental-effect/extensions/effect";
import type { WithEffectContext } from "@orpc/experimental-effect";
import { implement } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { CORSHandlerPlugin } from "@orpc/server/plugins";
import { Context } from "effect";

import { DESKTOP_RPC_PREFIX, desktopContract } from "../../shared/desktop-rpc";
import type { DesktopApplication } from "../application/desktop-application";

export type DesktopRequestHandler = (request: Request) => Promise<Response | undefined>;

type DesktopRpcContext = WithEffectContext<never>;

async function logErrors<T>({ next }: { next: () => Promise<T> }): Promise<T> {
  try {
    return await next();
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "AbortError")) {
      console.error("[desktop-rpc]", error);
    }
    throw error;
  }
}

export function makeDesktopRpcHandler(
  application: DesktopApplication,
  allowedOrigins: readonly string[],
): DesktopRequestHandler {
  const orpc = implement(desktopContract).$context<DesktopRpcContext>();

  const router = orpc.router({
    bootstrap: orpc.bootstrap.effect(function* () {
      return yield* application.bootstrap;
    }),
    status: {
      watch: orpc.status.watch.effect(function* ({ input }) {
        return yield* application.waitForBackendStatus(input.after);
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

  const handler = new RPCHandler(router, {
    clientInterceptors: [logErrors],
    plugins: [
      new CORSHandlerPlugin({
        origin: (origin) => (allowedOrigins.includes(origin) ? origin : null),
        allowMethods: ["POST", "OPTIONS"],
        maxAge: 600,
      }),
    ],
  });
  const context: DesktopRpcContext = { "effect/context": Context.empty() };

  return async (request) => {
    const result = await handler.handle(request, {
      prefix: DESKTOP_RPC_PREFIX,
      context,
    });
    return result.matched ? result.response : undefined;
  };
}
