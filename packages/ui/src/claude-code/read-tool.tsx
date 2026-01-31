import type { ReadUIToolInvocation } from "ai-sdk-agents/claude-code";

import { CodeBlock, CodeBlockCopyButton } from "@vibest/ui/ai-elements/code-block";
import { Tool, ToolContent, ToolHeader } from "@vibest/ui/ai-elements/tool";
import { FileTextIcon } from "lucide-react";

export function ClaudeCodeReadTool({ invocation }: { invocation: ReadUIToolInvocation }) {
  if (!invocation || invocation.state === "input-streaming") return null;
  const { input, output } = invocation;

  const code = output?.replace(/^\s*(\d+)→/gm, "");
  const language = input?.file_path?.match(/\.(\w+)$/)?.[1] || "text";

  return (
    <Tool>
      <ToolHeader icon={FileTextIcon}>Read {input?.file_path}</ToolHeader>
      <ToolContent>
        {code ? (
          <CodeBlock code={code} language={language} className="text-xs">
            <CodeBlockCopyButton />
          </CodeBlock>
        ) : null}
      </ToolContent>
    </Tool>
  );
}
