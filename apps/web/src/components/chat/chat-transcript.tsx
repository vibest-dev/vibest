import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@vibest/ui/ai-elements/conversation";
import { Loader } from "@vibest/ui/ai-elements/loader";
import { useStore } from "zustand";

import type { AgentResponse } from "@/core/chat/agent-requests";
import type { ChatStoreState } from "@/core/chat/chat-state";

import { useChatSession } from "./chat-session-context";
import { AgentRequestView } from "./transcript/agent-request";
import { MessageView } from "./transcript/message-view";
import { TranscriptRenderProvider } from "./transcript/transcript-render-context";

// Pure view over a store snapshot: message stream, then the error line, then
// pending agent request cards. Only the last message can be streaming, so only
// it gets streaming affordances.
export function ChatTranscriptView({
  snapshot,
  onRespond,
}: {
  snapshot: ChatStoreState;
  onRespond: (requestId: string, response: AgentResponse) => void;
}) {
  const lastIndex = snapshot.messages.length - 1;
  const turnInProgress = snapshot.status === "submitted" || snapshot.status === "streaming";
  return (
    <Conversation>
      <ConversationContent>
        {snapshot.messages.map((message, index) => (
          <MessageView
            key={message.id}
            message={message}
            isStreaming={turnInProgress && index === lastIndex}
          />
        ))}
        {snapshot.status === "submitted" && <Loader />}
        {snapshot.error && <div className="text-destructive text-xs">{snapshot.error.message}</div>}
        {snapshot.pendingRequests.map((request) => (
          <AgentRequestView key={request.id} request={request} onRespond={onRespond} />
        ))}
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  );
}

// Context-aware wrapper: subscribes to the whole store here so per-token
// message updates re-render only the transcript, never its siblings (the
// composer subscribes narrowly on its own).
export function ChatTranscript() {
  const { store, agentProviderId, respondToRequest } = useChatSession();
  const snapshot = useStore(store);
  return (
    <TranscriptRenderProvider agentProviderId={agentProviderId}>
      <ChatTranscriptView snapshot={snapshot} onRespond={respondToRequest} />
    </TranscriptRenderProvider>
  );
}
