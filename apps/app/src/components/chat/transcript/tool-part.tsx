import type { HarnessAgentId } from "@vibest/contract";
import type { DynamicToolUIPart, ToolUIPart, UIMessage } from "ai";
import type { ReactNode } from "react";
import { ErrorBoundary } from "react-error-boundary";

import { DynamicToolPart } from "./tool/dynamic-tool-part";
import { claudeCodeDynamicToolName } from "./tool/harness/claude-code/dynamic-name";
import { renderClaudeCodeTool } from "./tool/harness/claude-code/render-tool";
import { codexDynamicToolName } from "./tool/harness/codex/dynamic-name";
import { renderCodexTool } from "./tool/harness/codex/render-tool";
import { useTranscriptRender } from "./transcript-render-context";

type AnyToolPart = ToolUIPart | DynamicToolUIPart;

// Per-harness tool renderer: dispatch a tool part to that provider's per-tool
// registry, falling back to the shared DynamicToolPart (with the provider's
// display name) for tools it has no dedicated card for. A harness with no entry
// renders every tool through the generic card.
const TOOL_RENDERERS: Partial<
  Record<HarnessAgentId, (part: AnyToolPart, message: UIMessage) => ReactNode>
> = {
  "claude-code": (part, message) =>
    renderClaudeCodeTool(part, message) ?? (
      <DynamicToolPart part={part} name={claudeCodeDynamicToolName(part)} />
    ),
  codex: (part) =>
    renderCodexTool(part) ?? <DynamicToolPart part={part} name={codexDynamicToolName(part)} />,
};

const genericToolName = (part: AnyToolPart): string =>
  part.type === "dynamic-tool" ? part.toolName : part.type.replace(/^tool-/, "");

// tool-* / dynamic-tool dispatch: typed tool-* parts go through the provider's
// per-tool switch; unrecognized tools (dynamic-tool, or typed tools with no
// dedicated component) fall back to the shared DynamicToolPart with a
// provider-derived display name. One malformed payload degrades to a single
// fallback line instead of blanking the whole transcript; resetKeys re-arms
// the boundary when the part transitions state.
export function ToolPart({ message, part }: { message: UIMessage; part: AnyToolPart }) {
  if (part.state === "input-streaming") return null;
  return (
    <ErrorBoundary
      fallback={<div className="text-destructive text-xs">Failed to render tool output</div>}
      resetKeys={[part.type, part.toolCallId, part.state]}
    >
      <ToolPartContent message={message} part={part} />
    </ErrorBoundary>
  );
}

// Dispatch happens in a child component (not inline in ToolPart) because the
// provider render* calls are plain function calls, not components — they must
// execute inside the ErrorBoundary's child render stack for a throw to be
// caught.
function ToolPartContent({ message, part }: { message: UIMessage; part: AnyToolPart }) {
  const { harnessAgentId } = useTranscriptRender();
  const render = TOOL_RENDERERS[harnessAgentId];
  if (render) return render(part, message);
  return <DynamicToolPart part={part} name={genericToolName(part)} />;
}
