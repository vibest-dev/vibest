import type * as sdk from "@anthropic-ai/claude-agent-sdk";
import { oc, type } from "@orpc/contract";
import type { ClaudeCodeUIMessage, ToolPermissionRequest } from "@vibest/harness/claude-code";
import type { InferUIMessageChunk, UIMessage } from "ai";
import { z } from "zod";

// Emitted by the server while a prompt is running; the client answers via
// `respondPermission`. Defined next to the agent's permission flow in
// @vibest/harness; re-exported here because both sides speak it.
export type { ToolPermissionRequest };

export const claudeCodeContract = {
  session: {
    create: oc.output(type<{ sessionId: string }>()),
    abort: oc.input(z.object({ sessionId: z.string() })),
    getSupportedCommands: oc
      .input(z.object({ sessionId: z.string() }))
      .output(type<sdk.SlashCommand[]>()),
    getSupportedModels: oc
      .input(z.object({ sessionId: z.string() }))
      .output(type<sdk.ModelInfo[]>()),
    getMcpServers: oc
      .input(z.object({ sessionId: z.string() }))
      .output(type<sdk.McpServerStatus[]>()),
  },
  prompt: oc
    .input(
      type<{
        sessionId: string;
        message: UIMessage;
        model?: string;
      }>(),
    )
    .output(type<AsyncGenerator<InferUIMessageChunk<ClaudeCodeUIMessage>>>()),
  requestPermission: oc
    .input(z.object({ sessionId: z.string() }))
    .output(type<AsyncGenerator<ToolPermissionRequest>>()),
  respondPermission: oc
    .input(
      z.object({
        sessionId: z.string(),
        requestId: z.string(),
        result: z.custom<sdk.PermissionResult>(),
      }),
    )
    .output(z.boolean()),
};
