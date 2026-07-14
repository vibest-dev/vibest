import type { DynamicToolUIPart, ToolUIPart, UIMessage } from "ai";
import { ErrorBoundary } from "react-error-boundary";

import { DynamicToolPart } from "./tool/dynamic-tool-part";
import { claudeCodeDynamicToolName } from "./tool/providers/claude-code/dynamic-name";
import { renderClaudeCodeTool } from "./tool/providers/claude-code/render-tool";
import { useTranscriptRender } from "./transcript-render-context";

type AnyToolPart = ToolUIPart | DynamicToolUIPart;

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
  const { agentProviderId } = useTranscriptRender();
  const rendered = agentProviderId === "claude-code" ? renderClaudeCodeTool(part, message) : null;
  if (rendered) return rendered;
  return <DynamicToolPart part={part} name={claudeCodeDynamicToolName(part)} />;
}
