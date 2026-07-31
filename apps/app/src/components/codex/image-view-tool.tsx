import type { ImageViewUIToolInvocation } from "@vibest/contract/codex";
import { CodeBlock } from "@vibest/ui/ai-elements/code-block";
import { Tool, ToolContent, ToolHeader } from "@vibest/ui/ai-elements/tool";
import { ImageIcon } from "lucide-react";

export function CodexImageViewTool({ invocation }: { invocation: ImageViewUIToolInvocation }) {
  const { input } = invocation;
  const output = invocation.state === "output-available" ? invocation.output : undefined;
  return (
    <Tool>
      <ToolHeader icon={ImageIcon}>Image view</ToolHeader>
      <ToolContent>
        {input != null && (
          <div className="space-y-1.5">
            <span className="text-muted-foreground text-xs font-medium">Input</span>
            <CodeBlock code={JSON.stringify(input, null, 2)} language="json" />
          </div>
        )}
        {output != null && (
          <div className="space-y-1.5">
            <span className="text-muted-foreground text-xs font-medium">Output</span>
            <CodeBlock code={JSON.stringify(output, null, 2)} language="json" />
          </div>
        )}
      </ToolContent>
    </Tool>
  );
}
