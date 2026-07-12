import { oc, type } from "@orpc/contract";
import {
  type ClaudeCodeTools,
  McpServerStatusSchema,
  ModelInfoSchema,
  PermissionResultSchema,
  SlashCommandSchema,
  type ToolPermissionRequest,
} from "@vibest/harness/claude-code";
import type { InferUIMessageChunk, UIMessage } from "ai";
import { z } from "zod";

// Emitted by the server while a prompt is running; the client answers via
// `respondPermission`. Defined next to the agent's permission flow in
// @vibest/harness; re-exported here because both sides speak it.
export type { ToolPermissionRequest };

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
