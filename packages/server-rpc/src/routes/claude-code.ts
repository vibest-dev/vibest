import type { ClaudeCodeAgent } from "@vibest/agents/claude-code";

import { implement } from "@orpc/server";
import { toUIMessage } from "ai-sdk-agents/claude-code";

import { claudeCodeContract } from "../contract/claude-code";

export type ClaudeCodeContext = {
  claudeCodeAgent: ClaudeCodeAgent;
};

const os = implement(claudeCodeContract);
const orpc = os.$context<ClaudeCodeContext>();

const session = {
  create: orpc.session.create.handler(async ({ context: { claudeCodeAgent } }) => {
    return await claudeCodeAgent.session.create();
  }),
  abort: orpc.session.abort.handler(async ({ input, context: { claudeCodeAgent } }) => {
    claudeCodeAgent.session.abort(input.sessionId);
  }),
  getSupportedCommands: orpc.session.getSupportedCommands.handler(
    async ({ input, context: { claudeCodeAgent } }) => {
      return await claudeCodeAgent.session.getSupportedCommands(input.sessionId);
    },
  ),
  getSupportedModels: orpc.session.getSupportedModels.handler(
    async ({ input, context: { claudeCodeAgent } }) => {
      return await claudeCodeAgent.session.getSupportedModels(input.sessionId);
    },
  ),
  getMcpServers: orpc.session.getMcpServers.handler(
    async ({ input, context: { claudeCodeAgent } }) => {
      return await claudeCodeAgent.session.getMcpServers(input.sessionId);
    },
  ),
};

const prompt = orpc.prompt.handler(async ({ input, context: { claudeCodeAgent } }) => {
  const { model = "sonnet" } = input;
  const session = claudeCodeAgent.session.get(input.sessionId);

  // Set model before prompting
  await session.query.setModel(model);

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
      claudeCodeAgent.session.prompt({
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

const requestPermission = orpc.requestPermission.handler(async function* ({
  input,
  context: { claudeCodeAgent },
}) {
  const { sessionId } = input;
  const session = claudeCodeAgent.session.get(sessionId);
  for await (const event of session.requestPermission) {
    yield event;
  }
});

const respondPermission = orpc.respondPermission.handler(
  async ({ input, context: { claudeCodeAgent } }) => {
    const { sessionId, requestId, result } = input;
    try {
      return claudeCodeAgent.session.respondPermission(sessionId, requestId, result);
    } catch (error) {
      console.error("respondPermission error:", error);
      throw error;
    }
  },
);

export const claudeCodeRouter = orpc.router({
  session,
  prompt,
  requestPermission,
  respondPermission,
});
export type ClaudeCodeRouter = typeof claudeCodeRouter;
