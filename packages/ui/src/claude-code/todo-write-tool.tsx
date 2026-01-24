import { Tool, ToolContent, ToolHeader } from "@vibest/ui/ai-elements/tool";
import { cn } from "@vibest/ui/lib/utils";
import type { TodoWriteUIToolInvocation } from "ai-sdk-agents/claude-code";
import {
	ListChecksIcon,
	ListTodoIcon,
	SquareCheckIcon,
	SquareDotIcon,
	SquareIcon,
} from "lucide-react";

export function ClaudeCodeTodoWriteTool({
	invocation,
}: {
	invocation: TodoWriteUIToolInvocation;
}) {
	if (!invocation || invocation.state === "input-streaming") return null;
	const { input } = invocation;

	const allComplete =
		input?.todos?.every((todo) => todo.status === "completed") ?? false;

	return (
		<Tool>
			<ToolHeader icon={allComplete ? ListChecksIcon : ListTodoIcon}>
				Todo ({input?.todos?.length || 0} tasks)
			</ToolHeader>
			<ToolContent>
				{input?.todos && input.todos.length > 0 ? (
					<div className="space-y-2">
						{input.todos.map((todo, index) => (
							<div
								key={`${index}-${todo.content}`}
								className="flex items-start gap-3"
							>
								{todo.status === "completed" && (
									<SquareCheckIcon className="w-4 h-4 mt-0.5 flex-shrink-0" />
								)}
								{todo.status === "in_progress" && (
									<SquareDotIcon className="w-4 h-4 mt-0.5 flex-shrink-0" />
								)}
								{todo.status === "pending" && (
									<SquareIcon className="w-4 h-4 mt-0.5 flex-shrink-0" />
								)}
								<div className="flex-1 min-w-0">
									<p
										className={cn(
											"text-sm",
											todo.status === "completed" &&
												"line-through text-muted-foreground",
										)}
									>
										{todo.status === "in_progress"
											? todo.activeForm
											: todo.content}
									</p>
								</div>
							</div>
						))}
					</div>
				) : null}
			</ToolContent>
		</Tool>
	);
}
