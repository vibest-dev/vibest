import type { EditUIToolInvocation } from "ai-sdk-agents/claude-code";

import { CodeBlock } from "@vibest/ui/ai-elements/code-block";
import { Tool, ToolContent, ToolHeader } from "@vibest/ui/ai-elements/tool";
import { FilePenLine } from "lucide-react";

export function ClaudeCodeEditTool({ invocation }: { invocation: EditUIToolInvocation }) {
  if (!invocation || invocation.state === "input-streaming") return null;
  const { input } = invocation;

  const language = input?.file_path?.match(/\.(\w+)$/)?.[1] || "text";

  return (
    <Tool>
      <ToolHeader icon={FilePenLine}>Edit {input?.file_path}</ToolHeader>
      <ToolContent className="space-y-2">
        {input?.old_string ? (
          <>
            <h4 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
              Old String
            </h4>
            <CodeBlock code={input.old_string} language={language} className="text-xs" />
          </>
        ) : null}
        {input?.new_string ? (
          <>
            <h4 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
              New String
            </h4>
            <CodeBlock code={input.new_string} language={language} className="text-xs" />
          </>
        ) : null}
      </ToolContent>
    </Tool>
  );
}
