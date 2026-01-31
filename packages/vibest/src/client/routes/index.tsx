import { useNavigate } from "@tanstack/react-router";
import { Button } from "@vibest/ui/components/button";
import { useState } from "react";
import { orpcClient } from "@/lib/orpc";

export const Route = createFileRoute({
	component: Component,
});

function Component() {
	const navigate = useNavigate();
	const [isCreatingSession, setIsCreatingSession] = useState(false);

	const handleStartChatting = async () => {
		try {
			setIsCreatingSession(true);
			const { sessionId } = await orpcClient.claudeCode.session.create();
			navigate({ to: "/chat/$sessionId", params: { sessionId } });
		} catch (error) {
			console.error("Failed to create session", error);
			// TODO: Show error toast to user
		} finally {
			setIsCreatingSession(false);
		}
	};

	return (
		<div className="flex h-full items-center justify-center">
			<div className="max-w-2xl text-center space-y-6">
				<div className="space-y-4">
					<h1 className="text-4xl font-bold tracking-tight">
						Welcome to Claude Code
					</h1>
					<p className="text-xl text-muted-foreground">
						Your AI-powered coding companion. Get help with development tasks,
						code reviews, debugging, and more.
					</p>
				</div>

				<div className="grid gap-4 md:grid-cols-2 mt-8">
					<div className="p-6 border rounded-lg space-y-2">
						<h3 className="font-semibold">Code Analysis</h3>
						<p className="text-sm text-muted-foreground">
							Get insights into your codebase with intelligent analysis and
							suggestions.
						</p>
					</div>
					<div className="p-6 border rounded-lg space-y-2">
						<h3 className="font-semibold">Interactive Chat</h3>
						<p className="text-sm text-muted-foreground">
							Ask questions about your code and get instant, contextual
							responses.
						</p>
					</div>
					<div className="p-6 border rounded-lg space-y-2">
						<h3 className="font-semibold">Code Generation</h3>
						<p className="text-sm text-muted-foreground">
							Generate code snippets, functions, and components with AI
							assistance.
						</p>
					</div>
					<div className="p-6 border rounded-lg space-y-2">
						<h3 className="font-semibold">Debugging Help</h3>
						<p className="text-sm text-muted-foreground">
							Get help identifying and fixing bugs in your codebase.
						</p>
					</div>
				</div>

				<div className="flex gap-4 justify-center mt-8">
					<Button
						size="lg"
						onClick={handleStartChatting}
						disabled={isCreatingSession}
					>
						{isCreatingSession ? "Creating Session..." : "Start Chatting"}
					</Button>
					<Button
						variant="outline"
						size="lg"
						render={
							<a
								href="https://docs.claude.com"
								target="_blank"
								rel="noopener noreferrer"
							>
								View Documentation
							</a>
						}
					/>
				</div>
			</div>
		</div>
	);
}
