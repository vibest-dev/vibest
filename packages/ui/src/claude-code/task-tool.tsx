import type { ClaudeCodeTools, TaskUIToolInvocation } from "ai-sdk-agents/claude-code";

import { Response } from "@vibest/ui/ai-elements/response";
import { Tool, ToolContent, ToolHeader } from "@vibest/ui/ai-elements/tool";
import { isToolUIPart, type ToolUIPart, type UIDataTypes, type UIMessage } from "ai";
import { LayoutListIcon } from "lucide-react";
import { type ReactNode, useMemo } from "react";

export function ClaudeCodeTaskTool({
  message,
  invocation,
  renderToolPart,
}: {
  message: UIMessage<unknown, UIDataTypes, ClaudeCodeTools>;
  invocation: TaskUIToolInvocation;
  renderToolPart?: (part: ToolUIPart<ClaudeCodeTools>) => ReactNode;
}) {
  const childrenToolUIParts = useMemo(
    () =>
      message.parts
        .filter((part) => {
          if (!isToolUIPart(part)) return false;
          return (
            part.type !== "tool-Task" &&
            part.state !== "input-streaming" &&
            part.callProviderMetadata?.claudeCode?.parentToolUseId === invocation.toolCallId // this cause not type safe
          );
        })
        .filter((part) => isToolUIPart(part)),
    [message.parts, invocation.toolCallId],
  );

  if (!invocation || invocation.state === "input-streaming") return null;
  const { input, output } = invocation;

  return (
    <Tool>
      <ToolHeader icon={LayoutListIcon}>Task {input?.description}</ToolHeader>
      <ToolContent className="space-y-2">
        <div className="border">
          <div className="bg-primary-foreground border-b p-2 text-sm">Prompt</div>
          <div className="px-2 py-1">
            <Response>{input?.prompt}</Response>
          </div>
        </div>
        {childrenToolUIParts.map((part) => renderToolPart?.(part))}
        {Array.isArray(output)
          ? output.map((part) => {
              switch (part.type) {
                case "text":
                  return (
                    <div key={part.text}>
                      <Response>{part.text}</Response>
                    </div>
                  );
                default:
                  return null;
              }
            })
          : null}
      </ToolContent>
    </Tool>
  );
}
