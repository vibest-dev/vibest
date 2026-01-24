import { CodeBlock } from "@vibest/ui/ai-elements/code-block";
import { Tool, ToolContent, ToolHeader } from "@vibest/ui/ai-elements/tool";
import type { BashUIToolInvocation } from "ai-sdk-agents/claude-code";
import { SquareTerminalIcon } from "lucide-react";

export function ClaudeCodeBashTool({
	invocation,
}: {
	invocation: BashUIToolInvocation;
}) {
	if (!invocation || invocation.state === "input-streaming") return null;
	const { input, output } = invocation;

	// Create terminal-like output
	const terminalOutput = input?.command
		? `$ ${input.command}${output ? `\n${output}` : ""}`
		: output || "";

	return (
		<Tool>
			<ToolHeader icon={SquareTerminalIcon}>{input?.description}</ToolHeader>
			<ToolContent>
				{input?.command || output ? (
					<div className="relative">
						<CodeBlock
							code={terminalOutput}
							language="bash"
							className="text-sm"
						/>
					</div>
				) : null}
			</ToolContent>
		</Tool>
	);
}
