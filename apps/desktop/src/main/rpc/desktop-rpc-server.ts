import type { SupportedMessagePort } from "@orpc/client/message-port";
import { RPCHandler } from "@orpc/server/message-port";
import { Cause, type Context, Effect } from "effect";

import type { DesktopApplication } from "../application/desktop-application";
import { type DesktopRpcContext, makeDesktopRouter } from "./desktop-router";

export interface DesktopRpcServer {
  readonly attach: (port: SupportedMessagePort) => () => Promise<void>;
}

// oRPC turns expected ORPCError values into successes before this wrapper
// runs, so the tap only sees unexpected failures and defects; client
// cancellations arrive as interrupt-only causes and stay silent. oRPC applies
// `effect/context` inside the wrapper, so the trailing provide is what puts
// the composition root's Context behind the tap itself.
function makeWrapDesktopRpcEffect(rpcContext: Context.Context<never>) {
  return <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E> =>
    effect.pipe(
      Effect.tapCause((cause) =>
        Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logError("desktop rpc failed", cause),
      ),
      Effect.provide(rpcContext),
    );
}

export function makeDesktopRpcServer(
  application: DesktopApplication["Service"],
  rpcContext: Context.Context<never>,
): DesktopRpcServer {
  const handler = new RPCHandler(makeDesktopRouter(application));
  const context: DesktopRpcContext = {
    "effect/context": rpcContext,
    "effect/wrap": makeWrapDesktopRpcEffect(rpcContext),
  };

  return {
    attach: (port) => {
      handler.upgrade(port, { context });
      return () => handler.close(port);
    },
  };
}
