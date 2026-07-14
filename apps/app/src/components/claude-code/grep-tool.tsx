import type { GrepUIToolInvocation } from "@vibest/harness/claude-code";
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
        {output ? (
          <CodeBlock
            code={output.content ?? output.filenames.join("\n")}
            language="text"
            className="text-sm"
          />
        ) : null}
      </ToolContent>
    </Tool>
  );
}
