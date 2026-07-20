import type { DynamicToolUIPart, ToolUIPart } from "ai";

type AnyToolPart = ToolUIPart | DynamicToolUIPart;

// Display name for a codex tool part the per-tool switch didn't recognize
// (mcpToolCall / dynamicToolCall, surfaced as dynamic-tool). Codex wire names
// are already human-readable, so use the bare tool name.
export function codexDynamicToolName(part: AnyToolPart): string {
  return part.type === "dynamic-tool" ? part.toolName : part.type.replace(/^tool-/, "");
}
