import type { PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";

export type ClaudeCodeMetadata = undefined;

// Tool permission request event
export type ToolPermissionRequest = {
  type: "tool-permission-request";
  sessionId: string;
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  suggestions?: PermissionUpdate[];
};
