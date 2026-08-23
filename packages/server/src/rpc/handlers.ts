import { RPCHandler as WsRPCHandler } from "@orpc/server/websocket";
import { Cause, Context, Effect, Layer, ManagedRuntime } from "effect";
import type { WebSocket } from "ws";

import type { RpcContext } from "./context";
import { router } from "./router";
import { AgentRuntimeLayer } from "./runtime";

/**
 * Wrap every `.effect()` procedure. The oRPC effect bridge applies
 * `effect/context` before this wrapper, so the wrapper must re-provide the
 * process context around its own failure tap and span.
 *
 * One function here instruments all ~25 procedures at once: no router file
 * knows about logging, and none can forget to.
 *
 * Interrupt-only causes stay silent: oRPC turns declared `ORPCError`s into
 * successes before this runs, so what reaches the tap is either a genuine
 * defect or a client that disconnected mid-call. The latter is routine and
 * must not be reported as a server error.
 *
 * The native span names the procedure for any configured tracer. The failure
 * tap writes the actionable local record, including the procedure and cause.
 */
export function makeRpcWrap(effectContext: Context.Context<never> = Context.empty()) {
  return <A, E>(effect: Effect.Effect<A, E>, options: { readonly path: ReadonlyArray<string> }) => {
    const procedure = options.path.join(".");
    return effect.pipe(
      Effect.tapCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.logError("rpc procedure failed", cause).pipe(
              Effect.annotateLogs({ event: "rpc.failed", procedure }),
            ),
      ),
      // Outside the tap so a failure is logged inside the span it failed in.
      Effect.withSpan(`rpc.${procedure}`),
      Effect.provide(effectContext),
    );
  };
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

/** The process context is provided while constructing and running the graph. */
export async function createRpcRuntime(
  effectContext: Context.Context<never> = Context.empty(),
): Promise<RpcRuntime> {
  // `provideMerge`, not `mergeAll`: the process context carries the
  // observability loggers, and fibers forked while `AgentRuntimeLayer` is
  // building must see them. `mergeAll` leaves those forks on Effect's default
  // logger (OpenCode #34730).
  const runtime = ManagedRuntime.make(
    AgentRuntimeLayer.pipe(Layer.provideMerge(Layer.succeedContext(effectContext))),
  );
  const context: RpcContext = {
    "effect/context": await runtime.runPromise(runtime.contextEffect),
    "effect/wrap": makeRpcWrap(effectContext),
  };
  let disposing: Promise<void> | undefined;
  return {
    context,
    run: (effect) => runtime.runPromise(effect),
    dispose: () => (disposing ??= runtime.dispose()),
  };
}

export function createWsRPCHandler(rpcContext: RpcContext) {
  // Errors are reported by `effect/wrap` on the context, which — unlike a
  // client interceptor — runs inside Effect and so can tell an interrupted
  // call from a failed one.
  const wsHandler = new WsRPCHandler<RpcContext>(router);

  return function upgrade(ws: WebSocket) {
    wsHandler.upgrade(ws, {
      context: rpcContext,
    });
  };
}
