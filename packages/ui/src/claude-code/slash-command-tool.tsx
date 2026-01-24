import { Response } from "@vibest/ui/ai-elements/response";
import { Tool, ToolContent, ToolHeader } from "@vibest/ui/ai-elements/tool";
import { cn } from "@vibest/ui/lib/utils";
import type { UIDataTypes, UIMessage } from "ai";
import type {
	ClaudeCodeTools,
	SlashCommandUIToolInvocation,
} from "ai-sdk-agents/claude-code";
import { TerminalIcon } from "lucide-react";
import type { ReactNode } from "react";

export function ClaudeCodeSlashCommandTool({
	message: _message,
	invocation,
	renderToolPart: _renderToolPart,
}: {
	message: UIMessage<unknown, UIDataTypes, ClaudeCodeTools>;
	invocation: SlashCommandUIToolInvocation;
	renderToolPart?: (part: never) => ReactNode;
}) {
	if (!invocation || invocation.state === "input-streaming") return null;
	const { state, input, output, errorText } = invocation;
	const isError = state === "output-error";

	return (
		<Tool>
			<ToolHeader icon={TerminalIcon}>
				Execute slash command {input?.command}
			</ToolHeader>
			<ToolContent className="space-y-2">
				<div className={cn("border", isError && "border-destructive")}>
					<div
						className={cn(
							"p-2 border-b text-sm",
							isError && "border-destructive bg-destructive-foreground",
						)}
					>
						{input?.command}
					</div>
					<div className="px-2 py-1">
						<Response>
							{state === "output-available" ? output : errorText}
						</Response>
					</div>
				</div>
			</ToolContent>
		</Tool>
	);
}
