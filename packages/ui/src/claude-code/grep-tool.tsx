import type { GrepUIToolInvocation } from "ai-sdk-agents/claude-code";

import { CodeBlock } from "@vibest/ui/ai-elements/code-block";
import { Tool, ToolContent, ToolHeader } from "@vibest/ui/ai-elements/tool";
import { SearchIcon } from "lucide-react";

export function ClaudeCodeGrepTool({ invocation }: { invocation: GrepUIToolInvocation }) {
  if (!invocation || invocation.state === "input-streaming") return null;
  const { input, output } = invocation;

  return (
    <Tool>
      <ToolHeader icon={SearchIcon}>
        Grep for {input?.pattern ? `"${input.pattern}"` : ""}
        {input?.path ? ` in ${input.path}` : ""}
      </ToolHeader>
      <ToolContent>
        {typeof output === "string" ? (
          <CodeBlock code={output} language="json" className="text-sm" />
        ) : null}
      </ToolContent>
    </Tool>
  );
}
