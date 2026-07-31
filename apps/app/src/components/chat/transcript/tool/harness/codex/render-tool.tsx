import { codexTools, type CodexTools } from "@vibest/contract/codex";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import type { ReactNode } from "react";

import { CodexCollabAgentToolCallTool } from "@/components/codex/collab-agent-tool-call-tool";
import { CodexCommandExecutionTool } from "@/components/codex/command-execution-tool";
import { CodexFileChangeTool } from "@/components/codex/file-change-tool";
import { CodexImageGenerationTool } from "@/components/codex/image-generation-tool";
import { CodexImageViewTool } from "@/components/codex/image-view-tool";
import { CodexWebSearchTool } from "@/components/codex/web-search-tool";

type AnyToolPart = ToolUIPart | DynamicToolUIPart;

// Narrow to this provider's typed parts by checking the part type against the
// harness tool registry — the wire names are the single source of truth, so
// the guard can't drift from the schema definitions.
const codexToolTypes = new Set(Object.keys(codexTools).map((name) => `tool-${name}`));

function isCodexToolPart(part: AnyToolPart): part is ToolUIPart<CodexTools> {
  return part.type !== "dynamic-tool" && codexToolTypes.has(part.type);
}

// The codex per-tool render registry, symmetric with renderClaudeCodeTool:
// typed tool-* parts dispatch to their dedicated card; anything unrecognized
// (dynamic-tool — codex's mcpToolCall/dynamicToolCall arrive as dynamic)
// returns null so the caller falls back to the generic DynamicToolPart.
export function renderCodexTool(part: AnyToolPart): ReactNode | null {
  if (part.state === "input-streaming" || !isCodexToolPart(part)) return null;
  switch (part.type) {
    case "tool-commandExecution":
      return <CodexCommandExecutionTool invocation={part} />;
    case "tool-fileChange":
      return <CodexFileChangeTool invocation={part} />;
    case "tool-webSearch":
      return <CodexWebSearchTool invocation={part} />;
    case "tool-collabAgentToolCall":
      return <CodexCollabAgentToolCallTool invocation={part} />;
    case "tool-imageGeneration":
      return <CodexImageGenerationTool invocation={part} />;
    case "tool-imageView":
      return <CodexImageViewTool invocation={part} />;
    default:
      return null;
  }
}
