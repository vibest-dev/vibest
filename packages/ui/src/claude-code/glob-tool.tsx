import type { GlobUIToolInvocation } from "ai-sdk-agents/claude-code";

import { CodeBlock } from "@vibest/ui/ai-elements/code-block";
import { Tool, ToolContent, ToolHeader } from "@vibest/ui/ai-elements/tool";
import { FolderSearchIcon } from "lucide-react";

export function ClaudeCodeGlobTool({ invocation }: { invocation: GlobUIToolInvocation }) {
  if (!invocation || invocation.state === "input-streaming") return null;
  const { input, output } = invocation;

  return (
    <Tool>
      <ToolHeader icon={FolderSearchIcon}>
        Glob for {input?.pattern ? `"${input.pattern}"` : ""}
        {input?.path ? ` in ${input.path}` : ""}
      </ToolHeader>
      <ToolContent>
        {typeof output === "string" ? (
          <CodeBlock code={output} language="text" className="text-sm" />
        ) : null}
      </ToolContent>
    </Tool>
  );
}
