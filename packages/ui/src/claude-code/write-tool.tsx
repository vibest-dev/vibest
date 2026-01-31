import type { WriteUIToolInvocation } from "ai-sdk-agents/claude-code";

import { CodeBlock } from "@vibest/ui/ai-elements/code-block";
import { Tool, ToolContent, ToolHeader } from "@vibest/ui/ai-elements/tool";
import { SquarePen } from "lucide-react";

export function ClaudeCodeWriteTool({ invocation }: { invocation: WriteUIToolInvocation }) {
  if (!invocation || invocation.state === "input-streaming") return null;
  const { input } = invocation;

  const language = input?.file_path?.match(/\.(\w+)$/)?.[1] || "text";

  return (
    <Tool>
      <ToolHeader icon={SquarePen}>Write {input?.file_path}</ToolHeader>
      <ToolContent>
        {input?.content ? (
          <CodeBlock code={input.content} language={language} className="text-xs" />
        ) : null}
      </ToolContent>
    </Tool>
  );
}
