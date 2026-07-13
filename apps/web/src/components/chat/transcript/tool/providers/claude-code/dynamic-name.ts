import type { DynamicToolUIPart, ToolUIPart } from "ai";

type AnyToolPart = ToolUIPart | DynamicToolUIPart;

// Display name for a claude-code tool part the per-tool switch didn't
// recognize (an unknown MCP tool, or a typed tool with no dedicated
// component). Claude names its MCP tools `mcp__server__tool` — its OWN
// convention — so surface those as "server / tool"; anything else is the bare
// tool name. This lives in the claude-code provider dir (not the generic
// DynamicToolPart) because the `mcp__` shape is claude-specific.
export function claudeCodeDynamicToolName(part: AnyToolPart): string {
  const raw = part.type === "dynamic-tool" ? part.toolName : part.type.replace(/^tool-/, "");
  if (raw.startsWith("mcp__")) {
    const segments = raw.split("__");
    return `${segments[1] ?? "?"} / ${segments.slice(2).join("__") || "?"}`;
  }
  return raw;
}
