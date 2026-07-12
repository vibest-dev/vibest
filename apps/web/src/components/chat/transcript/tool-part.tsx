import type { ClaudeCodeTools } from "@vibest/harness/claude-code";
import type { ToolUIPart } from "ai";
import { ErrorBoundary } from "react-error-boundary";

import { ClaudeCodeToolUIPart } from "@/components/claude-code/tools";
import type { ClaudeCodeUIMessage } from "@/types";

// One malformed tool payload degrades to a single fallback line instead of
// blanking the whole transcript. resetKeys re-arms the boundary when the part
// transitions state.
export function ToolPart({
  message,
  part,
}: {
  message: ClaudeCodeUIMessage;
  part: ToolUIPart<ClaudeCodeTools>;
}) {
  return (
    <ErrorBoundary
      fallback={<div className="text-destructive text-xs">Failed to render tool output</div>}
      resetKeys={[part.type, part.toolCallId, part.state]}
    >
      <ClaudeCodeToolUIPart message={message} part={part} />
    </ErrorBoundary>
  );
}
