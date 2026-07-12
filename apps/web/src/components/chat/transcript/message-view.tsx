import { Tool, ToolContent, ToolHeader } from "@vibest/ui/ai-elements/tool";
import { isToolUIPart } from "ai";
import { ListTreeIcon } from "lucide-react";
import { useMemo } from "react";

import type { ClaudeCodeUIMessage } from "@/types";

import { AssistantMessage } from "./assistant-message";
import { plural } from "./compute-batch-trigger";
import { isChildToolPart } from "./use-tool-batches";
import { UserMessage } from "./user-message";

type Part = ClaudeCodeUIMessage["parts"][number];

export function MessageView({
  message,
  isStreaming,
}: {
  message: ClaudeCodeUIMessage;
  isStreaming: boolean;
}) {
  if (message.role === "assistant") {
    return <CollapsibleAssistantMessage message={message} isStreaming={isStreaming} />;
  }
  return <UserMessage message={message} />;
}

// Once a turn settles with a final answer, its tool/reasoning work folds
// behind a summary trigger and only the answer stays visible. Simplified from
// neo's summary-collapse: no result data parts exist here, so "settled with
// work followed by a trailing answer" is the collapse condition.
function CollapsibleAssistantMessage({
  message,
  isStreaming,
}: {
  message: ClaudeCodeUIMessage;
  isStreaming: boolean;
}) {
  const summary = useMemo(() => splitSummary(message.parts), [message.parts]);
  if (isStreaming || !summary) {
    return <AssistantMessage message={message} parts={message.parts} isStreaming={isStreaming} />;
  }
  return (
    <div>
      <Tool>
        <ToolHeader icon={ListTreeIcon}>{summary.label}</ToolHeader>
        <ToolContent>
          <AssistantMessage
            message={message}
            parts={summary.workParts}
            isStreaming={false}
            showActions={false}
          />
        </ToolContent>
      </Tool>
      <AssistantMessage message={message} parts={summary.answerParts} isStreaming={false} />
    </div>
  );
}

function splitSummary(
  parts: readonly Part[],
): { workParts: Part[]; answerParts: Part[]; label: string } | null {
  let lastWorkIndex = -1;
  let toolCallCount = 0;
  let reasoningCount = 0;
  for (const [index, part] of parts.entries()) {
    if (isToolUIPart(part)) {
      if (!isChildToolPart(part)) toolCallCount += 1;
      lastWorkIndex = index;
    } else if (part.type === "reasoning") {
      reasoningCount += 1;
      lastWorkIndex = index;
    }
  }
  if (lastWorkIndex < 0) return null;
  const workParts = parts.slice(0, lastWorkIndex + 1);
  const answerParts = parts.slice(lastWorkIndex + 1);
  if (!answerParts.some((part) => part.type === "text" && part.text.trim())) return null;
  const messageCount = workParts.filter((part) => part.type === "text" && part.text.trim()).length;
  const label = [
    toolCallCount > 0 ? `${toolCallCount} tool ${plural(toolCallCount, "call")}` : null,
    reasoningCount > 0 ? `${reasoningCount} ${plural(reasoningCount, "thought")}` : null,
    messageCount > 0 ? `${messageCount} ${plural(messageCount, "message")}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return { workParts, answerParts, label };
}
