import { RPCHandler as WsRPCHandler } from "@orpc/server/websocket";
import { ManagedRuntime } from "effect";
import type { WebSocket } from "ws";

import type { RpcContext } from "./context";
import { router } from "./router";
import { AgentRuntimeLayer } from "./runtime";

// Without this, a procedure that throws becomes a bare 500 with no trace of the
// cause anywhere — the client sees "Internal Server Error" and the server says
// nothing at all. Generic in the result so it types against every handler's
// own client-interceptor signature.
async function logErrors<T>({ next }: { next: () => Promise<T> }): Promise<T> {
  try {
    return await next();
  } catch (error) {
    console.error("[rpc]", error);
    throw error;
  }
}

export type RpcRuntime = {
  readonly context: RpcContext;
  readonly dispose: () => Promise<void>;
};

export async function createRpcRuntime(): Promise<RpcRuntime> {
  const runtime = ManagedRuntime.make(AgentRuntimeLayer);
  const context: RpcContext = {
    "effect/context": await runtime.runPromise(runtime.contextEffect),
  };
  let disposing: Promise<void> | undefined;
  return {
    context,
    dispose: () => (disposing ??= runtime.dispose()),
  };
}

export function createWsRPCHandler(rpcContext: RpcContext) {
  const wsHandler = new WsRPCHandler<RpcContext>(router, { clientInterceptors: [logErrors] });

  return function upgrade(ws: WebSocket) {
    wsHandler.upgrade(ws, {
      context: rpcContext,
    });
  };
}
