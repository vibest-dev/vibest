import "@orpc/experimental-effect/extensions/effect";

import type { WithEffectContext } from "@orpc/experimental-effect";

import { implement } from "@orpc/server";
import { claudeCodeContract } from "@vibest/contract/claude-code";
import { ClaudeCodeAgent } from "@vibest/harness/claude-code";
import { toUIMessage } from "@vibest/harness/claude-code";
import { Context, Effect, Layer } from "effect";

/**
 * The claude-code harness adapter as an Effect service. Procedures resolve it
 * from the oRPC context's `effect/context`; swapping the layer swaps the
 * agent (e.g. a mock in tests).
 */
export class ClaudeCode extends Context.Service<ClaudeCode, ClaudeCodeAgent>()("ClaudeCode") {}

export const ClaudeCodeLayer: Layer.Layer<ClaudeCode> = Layer.sync(
  ClaudeCode,
  () => new ClaudeCodeAgent(),
);

/** Services every RPC procedure may `yield*`. */
export type RpcContext = WithEffectContext<ClaudeCode>;

const orpc = implement(claudeCodeContract).$context<RpcContext>();

const session = {
  create: orpc.session.create.effect(function* () {
    const claudeCode = yield* ClaudeCode;
    return yield* Effect.promise(() => claudeCode.session.create());
  }),
  abort: orpc.session.abort.effect(function* ({ input }) {
    const claudeCode = yield* ClaudeCode;
    claudeCode.session.abort(input.sessionId);
  }),
  getSupportedCommands: orpc.session.getSupportedCommands.effect(function* ({ input }) {
    const claudeCode = yield* ClaudeCode;
    return yield* Effect.promise(() => claudeCode.session.getSupportedCommands(input.sessionId));
  }),
  getSupportedModels: orpc.session.getSupportedModels.effect(function* ({ input }) {
    const claudeCode = yield* ClaudeCode;
    return yield* Effect.promise(() => claudeCode.session.getSupportedModels(input.sessionId));
  }),
  getMcpServers: orpc.session.getMcpServers.effect(function* ({ input }) {
    const claudeCode = yield* ClaudeCode;
    return yield* Effect.promise(() => claudeCode.session.getMcpServers(input.sessionId));
  }),
};

const prompt = orpc.prompt.effect(function* ({ input }) {
  const claudeCode = yield* ClaudeCode;
  const { model = "sonnet" } = input;
  const session = claudeCode.session.get(input.sessionId);

  // Set model before prompting
  yield* Effect.promise(() => session.query.setModel(model));

  const message: { type: "text"; text: string }[] = [];
  for (const part of input.message.parts || []) {
    switch (part.type) {
      case "text":
        message.push({
          type: "text",
          text: part.text,
        });
        break;
      case "data-inspector":
        message.push({
          type: "text",
          // @ts-expect-error TODO fix me
          text: `i am current inspect target: ${part.data.map((d) => `@${d.file}:${d.line}:${d.column}`).join(", ")}`,
        });
        break;
    }
  }
  try {
    return toUIMessage(
      claudeCode.session.prompt({
        sessionId: input.sessionId,
        message: {
          role: "user",
          content: message,
        },
      }),
    );
  } catch (error) {
    console.error("Failed to prompt", error);
    throw error;
  }
});

const requestPermission = orpc.requestPermission.effect(function* ({ input }) {
  const claudeCode = yield* ClaudeCode;
  const session = claudeCode.session.get(input.sessionId);
  return (async function* () {
    for await (const event of session.requestPermission) {
      yield event;
    }
  })();
});

const respondPermission = orpc.respondPermission.effect(function* ({ input }) {
  const claudeCode = yield* ClaudeCode;
  const { sessionId, requestId, result } = input;
  try {
    return claudeCode.session.respondPermission(sessionId, requestId, result);
  } catch (error) {
    console.error("respondPermission error:", error);
    throw error;
  }
});

export const claudeCodeRouter = orpc.router({
  session,
  prompt,
  requestPermission,
  respondPermission,
});
export type ClaudeCodeRouter = typeof claudeCodeRouter;
