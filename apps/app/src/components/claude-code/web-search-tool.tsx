import type { WebSearchUIToolInvocation } from "@vibest/contract/claude-code";
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
        {/* `output` only exists once the tool has returned, so `results` is a
            settled array: it never reorders, grows or filters while mounted.
            Neither branch carries an id — a plain string has nothing to key on
            and a result group is only identified by its position. */}
        {output?.results.map((result, index) =>
          typeof result === "string" ? (
            // react-doctor-disable-next-line no-array-index-as-key
            <Response key={index}>{result}</Response>
          ) : (
            // react-doctor-disable-next-line no-array-index-as-key
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
