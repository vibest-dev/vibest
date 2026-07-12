import type { PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";
import type { InferUIMessageChunk, UIMessage } from "ai";

import { oc, type } from "@orpc/contract";
import {
  type ClaudeCodeTools,
  McpServerStatusSchema,
  ModelInfoSchema,
  PermissionResultSchema,
  SlashCommandSchema,
} from "ai-sdk-agents/claude-code";
import { z } from "zod";

// Emitted by the server while a prompt is running; the client answers via
// `respondPermission`. Lives in the contract because both sides speak it.
export type ToolPermissionRequest = {
  type: "tool-permission-request";
  sessionId: string;
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  suggestions?: PermissionUpdate[];
};

export const claudeCodeContract = {
  session: {
    create: oc.output(
      z.object({
        sessionId: z.string(),
      }),
    ),
    abort: oc.input(
      z.object({
        sessionId: z.string(),
      }),
    ),
    getSupportedCommands: oc
      .input(
        z.object({
          sessionId: z.string(),
        }),
      )
      .output(z.array(SlashCommandSchema)),
    getSupportedModels: oc
      .input(
        z.object({
          sessionId: z.string(),
        }),
      )
      .output(z.array(ModelInfoSchema)),
    getMcpServers: oc
      .input(
        z.object({
          sessionId: z.string(),
        }),
      )
      .output(z.array(McpServerStatusSchema)),
  },
  prompt: oc
    .input(
      type<{
        sessionId: string;
        message: UIMessage;
        model?: string;
      }>(),
    )
    .output(
      type<
        AsyncGenerator<
          InferUIMessageChunk<UIMessage<undefined, Record<string, unknown>, ClaudeCodeTools>>
        >
      >(),
    ),
  requestPermission: oc
    .input(
      z.object({
        sessionId: z.string(),
      }),
    )
    .output(type<AsyncGenerator<ToolPermissionRequest>>()),
  respondPermission: oc
    .input(
      z.object({
        sessionId: z.string(),
        requestId: z.string(),
        result: PermissionResultSchema,
      }),
    )
    .output(z.boolean()),
};
