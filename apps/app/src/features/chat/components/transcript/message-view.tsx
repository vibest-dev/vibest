import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@vibest/ui/components/collapsible";
import { isToolUIPart, type UIMessage } from "ai";
import { ListTreeIcon, SquareMinusIcon, SquarePlusIcon } from "lucide-react";
import { useMemo } from "react";

import { AssistantMessage } from "./assistant-message";
import { isChildToolPart } from "./tool/bucket";
import { UserMessage } from "./user-message";

type Part = UIMessage["parts"][number];

export function MessageView({
  message,
  isStreaming,
}: {
  message: UIMessage;
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
  message: UIMessage;
  isStreaming: boolean;
}) {
  const summary = useMemo(() => splitSummary(message.parts), [message.parts]);
  if (isStreaming || !summary) {
    return <AssistantMessage message={message} parts={message.parts} isStreaming={isStreaming} />;
  }
  return (
    <div>
      <Collapsible className="not-prose w-full py-1">
        <SummaryTrigger label={summary.label} />
        {/* Flush left, unlike a tool card's body: what folds here is whole
            messages, so indenting them behind a rule would nest the whole
            transcript one level in. */}
        <CollapsibleContent className="mt-2 space-y-2 transition-opacity data-ending-style:opacity-0 data-starting-style:opacity-0">
          <AssistantMessage
            message={message}
            parts={summary.workParts}
            isStreaming={false}
            showActions={false}
          />
        </CollapsibleContent>
      </Collapsible>
      <AssistantMessage message={message} parts={summary.answerParts} isStreaming={false} />
    </div>
  );
}

// The turn's icon swaps to a +/- box on hover or once open, the same
// affordance ToolHeader gives a tool card. Local rather than borrowed: this
// row summarises a turn, not a tool call, so it doesn't belong to that family.
function SummaryTrigger({ label }: { label: string }) {
  return (
    <CollapsibleTrigger
      className="group"
      render={
        <div className="text-muted-foreground hover:text-foreground flex w-full cursor-pointer items-center gap-2 overflow-hidden">
          <span className="relative">
            <ListTreeIcon className="size-4 group-hover:opacity-0 group-data-[panel-open]:opacity-0" />
            <div className="absolute inset-0 size-4 opacity-0 group-hover:opacity-100 group-data-[panel-open]:opacity-100">
              <SquarePlusIcon className="size-4 group-data-[panel-open]:hidden" />
              <SquareMinusIcon className="hidden size-4 group-data-[panel-open]:block" />
            </div>
          </span>
          <span className="truncate text-sm">{label}</span>
        </div>
      }
    />
  );
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return count === 1 ? singular : pluralForm;
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
