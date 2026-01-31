import type { BashOutputUIToolInvocation } from "ai-sdk-agents/claude-code";

import { CodeBlock } from "@vibest/ui/ai-elements/code-block";
import { Tool, ToolContent, ToolHeader } from "@vibest/ui/ai-elements/tool";
import { SquareTerminalIcon } from "lucide-react";

export function ClaudeCodeBashOutputTool({
  invocation,
}: {
  invocation: BashOutputUIToolInvocation;
}) {
  if (!invocation || invocation.state === "input-streaming") return null;
  const { input, output } = invocation;

  return (
    <Tool>
      <ToolHeader icon={SquareTerminalIcon}>
        Bash Output {input?.bash_id ? `(${input.bash_id})` : ""}
      </ToolHeader>
      <ToolContent>
        {output ? (
          <div className="relative">
            <CodeBlock code={output} language="bash" className="text-sm" />
          </div>
        ) : null}
      </ToolContent>
    </Tool>
  );
}
