import { Message, MessageContent } from "@vibest/ui/ai-elements/message";
import { Response } from "@vibest/ui/ai-elements/response";
import { ClaudeCodeToolUIPart } from "@vibest/ui/claude-code/tools";
import { isToolUIPart, type UIMessage } from "ai";
import type { ClaudeCodeTools } from "ai-sdk-agents/claude-code";

export type ClaudeCodeUIMessage = UIMessage<
	undefined,
	Record<string, never>,
	ClaudeCodeTools
>;

export function ClaudeCodeMessageParts({
	message,
}: {
	message: ClaudeCodeUIMessage;
}) {
	return (
		<div className="">
			{message.parts.map((part, index) => {
				if (isToolUIPart(part)) {
					return (
						<ClaudeCodeToolUIPart
							key={part.toolCallId}
							message={message}
							part={part}
						/>
					);
				}

				switch (part.type) {
					case "text": {
						return (
							<Message key={`${message.id}-${index}`} from={message.role}>
								<MessageContent>
									{message.role === "assistant" ? (
										<Response>{part.text}</Response>
									) : (
										<p>{part.text}</p>
									)}
								</MessageContent>
							</Message>
						);
					}
					default:
						return null;
				}
			})}
		</div>
	);
}
