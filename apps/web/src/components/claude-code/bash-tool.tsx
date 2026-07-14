import type { BashUIToolInvocation } from "@vibest/harness/claude-code";
import { CodeBlock } from "@vibest/ui/ai-elements/code-block";
import { Tool, ToolContent, ToolHeader } from "@vibest/ui/ai-elements/tool";
import { SquareTerminalIcon } from "lucide-react";

export function ClaudeCodeBashTool({ invocation }: { invocation: BashUIToolInvocation }) {
  if (!invocation || invocation.state === "input-streaming") return null;
  const { input, output } = invocation;

  // Create terminal-like output
  const outputText = output ? [output.stdout, output.stderr].filter(Boolean).join("\n") : "";
  const terminalOutput = input?.command
    ? `$ ${input.command}${outputText ? `\n${outputText}` : ""}`
    : outputText;

  return (
    <Tool>
      <ToolHeader icon={SquareTerminalIcon}>{input?.description}</ToolHeader>
      <ToolContent>
        {input?.command || outputText ? (
          <div className="relative">
            <CodeBlock code={terminalOutput} language="bash" className="text-sm" />
          </div>
        ) : null}
      </ToolContent>
    </Tool>
  );
}
