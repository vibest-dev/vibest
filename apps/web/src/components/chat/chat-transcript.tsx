import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@vibest/ui/ai-elements/conversation";
import { Loader } from "@vibest/ui/ai-elements/loader";

import { useChatSession } from "./chat-session-context";
import { AgentRequestView } from "./transcript/agent-request";
import { MessageView } from "./transcript/message-view";

// Renders the session's message stream from the ChatSession context; peers
// (composer, config) compose alongside it instead of receiving props. Only
// the last message can be streaming, so only it gets streaming affordances.
// Errors and pending agent requests render after the message list.
export function ChatTranscript() {
  const { messages, status, error, turnInProgress, pendingRequests, respondToRequest } =
    useChatSession();
  const lastIndex = messages.length - 1;
  return (
    <Conversation>
      <ConversationContent>
        {messages.map((message, index) => (
          <MessageView
            key={message.id}
            message={message}
            isStreaming={turnInProgress && index === lastIndex}
          />
        ))}
        {status === "submitted" && <Loader />}
        {error && <div className="text-destructive text-xs">{error.message}</div>}
        {pendingRequests.map((request) => (
          <AgentRequestView key={request.id} request={request} onRespond={respondToRequest} />
        ))}
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  );
}
