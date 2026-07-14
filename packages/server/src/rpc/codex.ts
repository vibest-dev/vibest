import "@orpc/experimental-effect/extensions/effect";
import { implement } from "@orpc/server";
import { codexContract } from "@vibest/contract/codex";
import { CodexAgent } from "@vibest/harness/codex";
import { Context, Effect, Layer } from "effect";

import type { RpcContext } from "./context";

/**
 * The codex harness adapter as an Effect service. Procedures resolve it from
 * the oRPC context's `effect/context`; swapping the layer swaps the agent
 * (e.g. a mock in tests).
 */
export class Codex extends Context.Service<Codex, CodexAgent>()("Codex") {}

export const CodexLayer: Layer.Layer<Codex> = Layer.sync(Codex, () => new CodexAgent());

const orpc = implement(codexContract).$context<RpcContext>();

const session = {
  create: orpc.session.create.effect(function* ({ input }) {
    const codex = yield* Codex;
    return yield* Effect.promise(() => codex.session.create(input));
  }),
  abort: orpc.session.abort.effect(function* ({ input }) {
    const codex = yield* Codex;
    yield* Effect.promise(() => codex.session.abort(input.sessionId));
  }),
};

const prompt = orpc.prompt.effect(function* ({ input }) {
  const codex = yield* Codex;
  return codex.session.prompt(input);
});

const requestPermission = orpc.requestPermission.effect(function* ({ input }) {
  const codex = yield* Codex;
  const requests = codex.session.requestPermission(input.sessionId);
  return (async function* () {
    for await (const request of requests) yield request;
  })();
});

const respondPermission = orpc.respondPermission.effect(function* ({ input }) {
  const codex = yield* Codex;
  return codex.session.respondPermission(input.sessionId, input.requestId, input.response);
});

export const codexRouter = orpc.router({ session, prompt, requestPermission, respondPermission });
export type CodexRouter = typeof codexRouter;
