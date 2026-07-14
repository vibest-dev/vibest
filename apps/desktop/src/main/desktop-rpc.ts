import "@orpc/experimental-effect/extensions/effect";
import type { WithEffectContext } from "@orpc/experimental-effect";
import { implement } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { CORSHandlerPlugin } from "@orpc/server/plugins";
import { Context, Effect, Option, Stream } from "effect";

import { DESKTOP_RPC_PREFIX, desktopContract } from "../shared/desktop-rpc";
import { DesktopLifecycle } from "./desktop-lifecycle";
import { BackendSupervisor } from "./supervisor";

export type DesktopRpcServices = BackendSupervisor | DesktopLifecycle;
export type DesktopRpcContext = WithEffectContext<DesktopRpcServices>;

const orpc = implement(desktopContract).$context<DesktopRpcContext>();

const bootstrap = orpc.bootstrap.effect(function* () {
  const backend = yield* BackendSupervisor;
  const current = yield* backend.snapshot;
  return {
    os: process.platform,
    backend: backend.connection,
    status: current.status,
    statusRevision: current.revision,
  };
});

const status = {
  watch: orpc.status.watch.effect(function* ({ input }) {
    const backend = yield* BackendSupervisor;
    const current = yield* backend.snapshot;
    if (current.revision > input.after) return current;

    const changed = yield* backend.changes.pipe(
      Stream.filter((next) => next.revision > input.after),
      Stream.runHead,
      Effect.timeoutOrElse({
        duration: "20 seconds",
        orElse: () => Effect.succeed(Option.none()),
      }),
    );
    return Option.getOrElse(changed, () => current);
  }),
};

const backend = {
  retry: orpc.backend.retry.effect(function* () {
    const supervisor = yield* BackendSupervisor;
    yield* supervisor.retry;
  }),
};

const desktopApp = {
  quit: orpc.app.quit.effect(function* () {
    const lifecycle = yield* DesktopLifecycle;
    yield* lifecycle.requestQuit;
  }),
};

export const desktopRouter = orpc.router({ bootstrap, status, backend, app: desktopApp });
export type DesktopRouter = typeof desktopRouter;

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

export function createDesktopRpcHandler(
  effectContext: Context.Context<DesktopRpcServices>,
  allowedOrigins: readonly string[],
) {
  const context: DesktopRpcContext = { "effect/context": effectContext };
  const handler = new RPCHandler(desktopRouter, {
    clientInterceptors: [logErrors],
    plugins: [
      new CORSHandlerPlugin({
        origin: (origin) => (allowedOrigins.includes(origin) ? origin : null),
        allowMethods: ["POST", "OPTIONS"],
        maxAge: 600,
      }),
    ],
  });

  return (request: Request) =>
    handler.handle(request, {
      prefix: DESKTOP_RPC_PREFIX,
      context,
    });
}
