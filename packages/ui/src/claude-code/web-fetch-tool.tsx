import type { WebFetchUIToolInvocation } from "ai-sdk-agents/claude-code";

import { CodeBlock } from "@vibest/ui/ai-elements/code-block";
import { Response } from "@vibest/ui/ai-elements/response";
import { Tool, ToolContent, ToolHeader } from "@vibest/ui/ai-elements/tool";
import { GlobeIcon } from "lucide-react";

export function ClaudeCodeWebFetchTool({ invocation }: { invocation: WebFetchUIToolInvocation }) {
  if (!invocation || invocation.state === "input-streaming") return null;
  const { input, output } = invocation;

  return (
    <Tool>
      <ToolHeader icon={GlobeIcon}>WebFetch {input?.url}</ToolHeader>
      <ToolContent>
        {input?.url ? (
          <div className="space-y-2 px-4 pb-4">
            <h4 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
              URL
            </h4>
            <CodeBlock code={input.url} language="text" className="text-sm" />
          </div>
        ) : null}
        {input?.prompt ? (
          <div className="space-y-2 px-4 pb-4">
            <h4 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
              Prompt
            </h4>
            <CodeBlock code={input.prompt} language="text" className="text-sm" />
          </div>
        ) : null}
        {output ? (
          <div className="space-y-2 px-4 pb-4">
            <h4 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
              Result
            </h4>
            <Response>{output}</Response>
          </div>
        ) : null}
      </ToolContent>
    </Tool>
  );
}
