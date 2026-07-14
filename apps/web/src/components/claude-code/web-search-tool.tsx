import type { WebSearchUIToolInvocation } from "@vibest/harness/claude-code";
import { Response } from "@vibest/ui/ai-elements/response";
import { Tool, ToolContent, ToolHeader } from "@vibest/ui/ai-elements/tool";
import { SearchIcon } from "lucide-react";

export function ClaudeCodeWebSearchTool({ invocation }: { invocation: WebSearchUIToolInvocation }) {
  if (!invocation || invocation.state === "input-streaming") return null;
  const { input, output } = invocation;

  return (
    <Tool>
      <ToolHeader icon={SearchIcon}>WebSearch "{input?.query}"</ToolHeader>
      <ToolContent>
        {output?.results.map((result, index) =>
          typeof result === "string" ? (
            <Response key={index}>{result}</Response>
          ) : (
            <ul key={index} className="space-y-1 text-sm">
              {result.content.map((hit) => (
                <li key={hit.url}>
                  <a href={hit.url} target="_blank" rel="noreferrer" className="underline">
                    {hit.title}
                  </a>
                </li>
              ))}
            </ul>
          ),
        )}
      </ToolContent>
    </Tool>
  );
}
