import { CodeBlock } from "@vibest/ui/ai-elements/code-block";
import { Tool, ToolContent, ToolHeader } from "@vibest/ui/ai-elements/tool";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import { WrenchIcon } from "lucide-react";

type AnyToolPart = ToolUIPart | DynamicToolUIPart;

// dynamic-tool input/output shapes are unconstrained (any MCP server can feed
// them); JSON.stringify can throw on cycles — fall back to a placeholder
// instead of letting the card crash.
function serialize(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "Failed to render tool output";
  }
}

// Fallback tool card for any tool-* / dynamic-tool part with no dedicated
// component (unknown MCP tools). Purely presentational and name-agnostic —
// `name` is injected by the caller; provider-specific display-name derivation
// stays in each provider dir.
export function DynamicToolPart({ part, name }: { part: AnyToolPart; name: string }) {
  const input = part.input as Record<string, unknown> | undefined;
  return (
    <Tool>
      <ToolHeader icon={WrenchIcon}>{name}</ToolHeader>
      <ToolContent>
        {input != null && (
          <div className="space-y-1.5">
            <span className="text-muted-foreground text-xs font-medium">Input</span>
            <CodeBlock code={serialize(input)} language="json" />
          </div>
        )}
        {part.output != null && (
          <div className="space-y-1.5">
            <span className="text-muted-foreground text-xs font-medium">Output</span>
            <CodeBlock code={serialize(part.output)} language="json" />
          </div>
        )}
      </ToolContent>
    </Tool>
  );
}
