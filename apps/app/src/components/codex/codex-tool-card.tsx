import { CodeBlock } from "@vibest/ui/ai-elements/code-block";
import { Tool, ToolContent, ToolHeader } from "@vibest/ui/ai-elements/tool";
import type { LucideIcon } from "lucide-react";

// Codex tool inputs/outputs are protocol-typed but shapes vary per tool;
// JSON.stringify can throw on cycles — fall back to a placeholder instead of
// crashing the card.
function serialize(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "Failed to render tool output";
  }
}

// The shared simple card for every codex tool: an icon + label header over the
// raw input/output as JSON blocks. Kept deliberately generic — codex cards are
// input/output-only for now, so per-tool components would just be boilerplate.
export function CodexToolCard({
  icon,
  title,
  input,
  output,
}: {
  icon: LucideIcon;
  title: string;
  input?: unknown;
  output?: unknown;
}) {
  const inputText = serialize(input);
  const outputText = serialize(output);
  return (
    <Tool>
      <ToolHeader icon={icon}>{title}</ToolHeader>
      <ToolContent>
        {inputText && (
          <div className="space-y-1.5">
            <span className="text-muted-foreground text-xs font-medium">Input</span>
            <CodeBlock code={inputText} language="json" />
          </div>
        )}
        {outputText && (
          <div className="space-y-1.5">
            <span className="text-muted-foreground text-xs font-medium">Output</span>
            <CodeBlock code={outputText} language="json" />
          </div>
        )}
      </ToolContent>
    </Tool>
  );
}
