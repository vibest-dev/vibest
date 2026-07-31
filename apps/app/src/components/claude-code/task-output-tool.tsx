import type { TaskOutputUIToolInvocation } from "@vibest/contract/claude-code";
import { CodeBlock } from "@vibest/ui/ai-elements/code-block";
import { Tool, ToolContent, ToolHeader } from "@vibest/ui/ai-elements/tool";
import { SquareTerminalIcon } from "lucide-react";

// Successor to the removed BashOutput card (BashOutput→TaskOutput upstream).
// The SDK exports no output type for TaskOutput, so the registry types it as
// `unknown`; render the terminal text only when it really is a string and
// leave the structured-output case to the generic fallback.
export function ClaudeCodeTaskOutputTool({
  invocation,
}: {
  invocation: TaskOutputUIToolInvocation;
}) {
  if (!invocation || invocation.state === "input-streaming") return null;
  const { input, output } = invocation;
  const text = typeof output === "string" ? output : undefined;

  return (
    <Tool>
      <ToolHeader icon={SquareTerminalIcon}>
        Task Output {input?.task_id ? `(${input.task_id})` : ""}
      </ToolHeader>
      <ToolContent>
        {text ? (
          <div className="relative">
            <CodeBlock code={text} language="bash" className="text-sm" />
          </div>
        ) : null}
      </ToolContent>
    </Tool>
  );
}
