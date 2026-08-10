import { RPCHandler as WsRPCHandler } from "@orpc/server/websocket";
import { Cause, Effect, Layer, ManagedRuntime } from "effect";
import type { WebSocket } from "ws";

import { defaultTelemetryRuntime, type TelemetryRuntime, withLoggedSpan } from "../telemetry";
import type { RpcContext } from "./context";
import { router } from "./router";
import { AgentRuntimeLayer } from "./runtime";

/**
 * Wrap every `.effect()` procedure. The oRPC effect bridge applies
 * `effect/context` *inside* this wrapper, so the trailing `provide` is what
 * puts the composition root's services behind the tap itself — the same shape
 * `apps/desktop`'s `desktop-rpc-server.ts` uses.
 *
 * One function here instruments all ~25 procedures at once: no router file
 * knows about logging, and none can forget to.
 *
 * Interrupt-only causes stay silent: oRPC turns declared `ORPCError`s into
 * successes before this runs, so what reaches the tap is either a genuine
 * defect or a client that disconnected mid-call. The latter is routine and
 * must not be reported as a server error.
 *
 * The span does two jobs and neither is stated at any call site. It makes the
 * JSONL navigable — every line a procedure produces, through the session
 * service, the repositories, an adapter, carries this call's `traceId`, so one
 * request reassembles with `jq 'select(.traceId=="…")'`. `withLoggedSpan`
 * writes the per-call completion record before the span closes: name, duration,
 * and outcome, without clock or lifecycle code here.
 *
 * What remains below is the one thing a span cannot carry: the failure's cause.
 */
export function makeRpcWrap(telemetry: TelemetryRuntime) {
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
      withLoggedSpan(`rpc.${procedure}`),
      telemetry.provide,
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

/**
 * @param telemetry the process's one telemetry runtime. Defaults to Effect's
 * standard context in tests.
 */
export async function createRpcRuntime(
  telemetry: TelemetryRuntime = defaultTelemetryRuntime,
): Promise<RpcRuntime> {
  const runtime = ManagedRuntime.make(telemetry.provideToLayer(AgentRuntimeLayer));
  const context: RpcContext = {
    "effect/context": await runtime.runPromise(runtime.contextEffect),
    "effect/wrap": makeRpcWrap(telemetry),
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
