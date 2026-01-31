import type { MultiEditUIToolInvocation } from "ai-sdk-agents/claude-code";

import { CodeBlock } from "@vibest/ui/ai-elements/code-block";
import { Tool, ToolContent, ToolHeader } from "@vibest/ui/ai-elements/tool";
import { EditIcon } from "lucide-react";

export function ClaudeCodeMultiEditTool({ invocation }: { invocation: MultiEditUIToolInvocation }) {
  if (!invocation || invocation.state === "input-streaming") return null;
  const { input } = invocation;

  const language = input?.file_path?.match(/\.(\w+)$/)?.[1] || "text";

  return (
    <Tool>
      <ToolHeader icon={EditIcon}>
        MultiEdit {input?.file_path} ({input?.edits?.length || 0} edits)
      </ToolHeader>
      <ToolContent>
        {input?.edits?.map((edit, index) => (
          <div key={edit.old_string}>
            <h4 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
              Edit {index + 1}
            </h4>
            {edit?.old_string ? (
              <div className="space-y-2 px-4 pb-4">
                <h4 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                  Old String
                </h4>
                <CodeBlock code={edit.old_string} language={language} className="text-xs" />
              </div>
            ) : null}
            {edit?.new_string ? (
              <div className="space-y-2 px-4 pb-4">
                <h4 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                  New String
                </h4>
                <CodeBlock code={edit.new_string} language={language} className="text-xs" />
              </div>
            ) : null}
          </div>
        ))}
      </ToolContent>
    </Tool>
  );
}
