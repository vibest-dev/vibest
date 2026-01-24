import { consumeEventIterator } from "@orpc/client";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@vibest/ui/components/button";
import { useEffect, useRef } from "react";
import { Chat } from "@/components/chat";
import { orpcClient, orpcWsClient } from "@/lib/orpc";

export const Route = createFileRoute({
	component: Component,
});

function Component() {
	const { sessionId } = Route.useParams();
	const navigate = useNavigate();
	const sessionIdRef = useRef<string>(sessionId);

	// Sync sessionId to ref for event handlers
	useEffect(() => {
		sessionIdRef.current = sessionId;
	}, [sessionId]);

	// Set up permission request handling
	useEffect(() => {
		const isAbortError = (error: unknown) =>
			error instanceof DOMException && error.name === "AbortError";

		const abortController = new AbortController();
		const unsubscribe = consumeEventIterator(
			orpcWsClient.claudeCode.requestPermission(
				{ sessionId },
				{ signal: abortController.signal },
			),
			{
				onEvent: async (event) => {
					console.log("Tool permission request:", event);

					// 使用 ref 获取最新的 sessionId
					const currentSessionId = sessionIdRef.current;
					if (!currentSessionId) {
						console.error("Session ID not found");
						return;
					}

					// Show permission request using browser confirm dialog
					const message = `Tool Permission Request:\n\nTool: ${event.toolName}\nRequest ID: ${event.requestId}\n\nInput: ${JSON.stringify(event.input, null, 2)}\n\nAllow this tool to execute?`;

					const userConfirmed = window.confirm(message);

					// Respond to permission request
					try {
						if (userConfirmed) {
							await orpcWsClient.claudeCode.respondPermission({
								sessionId,
								requestId: event.requestId,
								result: {
									behavior: "allow",
									updatedInput: event.input,
								},
							});
						} else {
							await orpcWsClient.claudeCode.respondPermission({
								sessionId,
								requestId: event.requestId,
								result: {
									behavior: "deny",
									message: "User denied the permission request",
									interrupt: true,
								},
							});
						}
					} catch (error) {
						console.error("Failed to respond to permission request:", error);
					}
				},
				onError: (error) => {
					if (isAbortError(error)) {
						return;
					}
					console.error("Tool permission error:", error);
				},
				onFinish: () => {
					console.log("Tool permission stream finished");
				},
			},
		);

		return () => {
			abortController.abort();
			void unsubscribe().catch((error) => {
				if (isAbortError(error)) {
					return;
				}
				console.error(
					"Failed to unsubscribe from tool permission stream",
					error,
				);
			});
		};
	}, [sessionId]);

	const handleNewSession = async () => {
		try {
			// Create new session and navigate
			const { sessionId: newSessionId } =
				await orpcClient.claudeCode.session.create();
			navigate({ to: "/chat/$sessionId", params: { sessionId: newSessionId } });
		} catch (error) {
			console.error("Failed to start a new session", error);
		}
	};

	return (
		<div className="flex h-full flex-col">
			<div className="flex items-center justify-between p-2 border-b bg-background">
				<Button
					size="sm"
					className="ml-auto"
					variant="outline"
					onClick={handleNewSession}
				>
					New Session
				</Button>
			</div>
			<Chat
				className="w-full min-w-80 max-w-4xl mx-auto"
				sessionId={sessionId}
			/>
		</div>
	);
}
