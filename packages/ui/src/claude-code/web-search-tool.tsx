import { Response } from "@vibest/ui/ai-elements/response";
import { Tool, ToolContent, ToolHeader } from "@vibest/ui/ai-elements/tool";
import type { WebSearchUIToolInvocation } from "ai-sdk-agents/claude-code";
import { SearchIcon } from "lucide-react";

export function ClaudeCodeWebSearchTool({
	invocation,
}: {
	invocation: WebSearchUIToolInvocation;
}) {
	if (!invocation || invocation.state === "input-streaming") return null;
	const { input, output } = invocation;

	return (
		<Tool>
			<ToolHeader icon={SearchIcon}>WebSearch "{input?.query}"</ToolHeader>
			<ToolContent>{output ? <Response>{output}</Response> : null}</ToolContent>
		</Tool>
	);
}
