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
import { TranscriptRenderProvider } from "./transcript/transcript-render-provider";

// Pure view over a store snapshot: message stream, then the error line, then
// pending agent request cards. Only the last message can be streaming, so only
// it gets streaming affordances.
function ChatTranscriptView({
  snapshot,
  onRespond,
}: {
  snapshot: ChatStoreState;
  onRespond: (requestId: string, response: AgentResponse) => void;
}) {
  const lastIndex = snapshot.messages.length - 1;
  const turnInProgress = snapshot.status === "submitted" || snapshot.status === "streaming";
  // A reopened session hydrates its transcript from native history where the
  // harness supports it (pi today) — then this notice never shows. It remains
  // for the harnesses without a history read: the agent still resumes with its
  // own context, so the conversation continues regardless.
  const showEmptyNotice = snapshot.messages.length === 0 && snapshot.status === "ready";
  return (
    <Conversation>
      <ConversationContent>
        {showEmptyNotice && (
          <div className="text-muted-foreground mx-auto max-w-md py-12 text-center text-sm">
            Past messages can&apos;t be replayed yet. The agent still has its own context, so you
            can pick up where you left off.
          </div>
        )}
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
  const { store, harnessAgentId, respondToRequest } = useChatSession();
  const snapshot = useStore(store);
  return (
    <TranscriptRenderProvider harnessAgentId={harnessAgentId}>
      <ChatTranscriptView snapshot={snapshot} onRespond={respondToRequest} />
    </TranscriptRenderProvider>
  );
}
