import { RPCHandler as WsRPCHandler } from "@orpc/server/websocket";
import { Cause, Context, Effect, Layer, ManagedRuntime } from "effect";
import type { WebSocket } from "ws";

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
 * request reassembles with `jq 'select(.traceId=="…")'`. And because
 * `telemetry/tracer.ts` logs spans as they close, it *is* the per-call record:
 * name, duration and outcome, with no clock read or `onExit` written here.
 *
 * What remains below is the one thing a span cannot carry: the failure's cause.
 */
export function makeRpcWrap(telemetry: Context.Context<never>) {
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
      // Inside `provide` so the span sees the telemetry context, and outside
      // the tap so a failure is logged with the span it failed in.
      Effect.withSpan(`rpc.${procedure}`),
      Effect.provide(telemetry),
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
 * @param telemetry the process's one logging context (see
 * `telemetry/runtime.ts`). Merged into this runtime rather than rebuilt,
 * because `CurrentLoggers` is a per-context reference: building a second
 * telemetry layer here would put a second set of loggers on the same file.
 * Defaults to empty so tests get the plain Effect logger.
 */
export async function createRpcRuntime(
  telemetry: Context.Context<never> = Context.empty(),
): Promise<RpcRuntime> {
  // `provideMerge`, not `mergeAll`: merging would put telemetry *beside*
  // `AgentRuntimeLayer` and leave everything built inside it — including any
  // context a service captures for a synchronous callback — on the default
  // logger. Providing pushes the references down the whole tree, and the
  // `Merge` half keeps them in the output context for the RPC handlers.
  const runtime = ManagedRuntime.make(
    AgentRuntimeLayer.pipe(Layer.provideMerge(Layer.succeedContext(telemetry))),
  );
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
