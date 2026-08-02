import { ORPCError } from "@orpc/server";
import { RPCHandler as WsRPCHandler } from "@orpc/server/websocket";
import type { Effect, Layer } from "effect";
import { ManagedRuntime } from "effect";
import type { WebSocket } from "ws";

import type { RpcContext } from "./context";
import { router } from "./router";
import { AgentRuntimeLayer } from "./runtime";
import { makeWrapRpcEffect } from "./wrap";

// Backstop for failures that never enter an effect handler (transport and
// stream plumbing). Anything from a handler is an ORPCError by now — expected
// protocol errors, or the wrap boundary's already-logged internal error — so those
// stay quiet here. Generic in the result so it types against every handler's
// own client-interceptor signature.
async function logNonProtocolErrors<T>({ next }: { next: () => Promise<T> }): Promise<T> {
  try {
    return await next();
  } catch (error) {
    if (!(error instanceof ORPCError)) console.error("[rpc]", error);
    throw error;
  }
}

export type RpcRuntime = {
  readonly context: RpcContext;
  /**
   * Run an effect on the server's own runtime. `http/server.ts` is Promise-
   * shaped (node:http + ws + Vite share one server), so this is how the
   * Effect-native pieces it wires up — the UI handler — get their services
   * without a second composition root.
   */
  readonly run: <A, E>(effect: Effect.Effect<A, E, AgentRuntime>) => Promise<A>;
  readonly dispose: () => Promise<void>;
};

/** Everything `AgentRuntimeLayer` provides, as a requirement. */
type AgentRuntime = Layer.Success<typeof AgentRuntimeLayer>;

export async function createRpcRuntime(): Promise<RpcRuntime> {
  const runtime = ManagedRuntime.make(AgentRuntimeLayer);
  const effectContext = await runtime.runPromise(runtime.contextEffect);
  const context: RpcContext = {
    "effect/context": effectContext,
    "effect/wrap": makeWrapRpcEffect(effectContext),
  };
  let disposing: Promise<void> | undefined;
  return {
    context,
    run: (effect) => runtime.runPromise(effect),
    dispose: () => (disposing ??= runtime.dispose()),
  };
}

export function createWsRPCHandler(rpcContext: RpcContext) {
  const wsHandler = new WsRPCHandler<RpcContext>(router, {
    clientInterceptors: [logNonProtocolErrors],
  });

  return function upgrade(ws: WebSocket) {
    wsHandler.upgrade(ws, {
      context: rpcContext,
    });
  };
}
