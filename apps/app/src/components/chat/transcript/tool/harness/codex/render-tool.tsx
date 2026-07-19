import type { CodexTools } from "@vibest/harness/codex";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import type { ReactNode } from "react";

import { CodexCollabAgentToolCallTool } from "@/components/codex/collab-agent-tool-call-tool";
import { CodexCommandExecutionTool } from "@/components/codex/command-execution-tool";
import { CodexFileChangeTool } from "@/components/codex/file-change-tool";
import { CodexImageGenerationTool } from "@/components/codex/image-generation-tool";
import { CodexImageViewTool } from "@/components/codex/image-view-tool";
import { CodexWebSearchTool } from "@/components/codex/web-search-tool";

type AnyToolPart = ToolUIPart | DynamicToolUIPart;

// The codex per-tool render registry, symmetric with renderClaudeCodeTool:
// typed tool-* parts dispatch to their dedicated card; anything unrecognized
// (dynamic-tool — codex's mcpToolCall/dynamicToolCall arrive as dynamic)
// returns null so the caller falls back to the generic DynamicToolPart. The
// cast is the provider trust boundary — the harness transform guarantees
// tool-* parts of this provider match CodexTools.
export function renderCodexTool(part: AnyToolPart): ReactNode | null {
  if (part.type === "dynamic-tool" || part.state === "input-streaming") return null;
  const typed = part as ToolUIPart<CodexTools>;
  switch (typed.type) {
    case "tool-commandExecution":
      return <CodexCommandExecutionTool invocation={typed} />;
    case "tool-fileChange":
      return <CodexFileChangeTool invocation={typed} />;
    case "tool-webSearch":
      return <CodexWebSearchTool invocation={typed} />;
    case "tool-collabAgentToolCall":
      return <CodexCollabAgentToolCallTool invocation={typed} />;
    case "tool-imageGeneration":
      return <CodexImageGenerationTool invocation={typed} />;
    case "tool-imageView":
      return <CodexImageViewTool invocation={typed} />;
    default:
      return null;
  }
}
