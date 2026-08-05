import { Loader } from "@vibest/ui/ai-elements/loader";
import { useStore } from "zustand";

import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/conversation";
import type { AgentResponse } from "@/features/chat/runtime/agent-requests";
import type { ChatStoreState, HistoryStatus } from "@/features/chat/runtime/chat-state";

import { useChatSession } from "./chat-session-context";
import { AgentRequestView } from "./transcript/agent-request";
import { MessageView } from "./transcript/message-view";
import { TranscriptRenderProvider } from "./transcript/transcript-render-provider";

// What an empty transcript means, in one place: nothing until the settled
// history floor has landed, so an unread session shows the read rather than a
// verdict about the conversation. "settled" renders nothing — a session with no
// messages simply has none yet.
function EmptyTranscript({ historyStatus }: { historyStatus: HistoryStatus }) {
  if (historyStatus === "loading") {
    return (
      <div className="flex justify-center py-12">
        <Loader />
      </div>
    );
  }
  if (historyStatus === "unavailable") {
    return (
      <div className="text-muted-foreground mx-auto max-w-md py-12 text-center text-sm">
        Earlier messages couldn&apos;t be loaded. The agent still has its own context, so you can
        pick up where you left off.
      </div>
    );
  }
  return null;
}

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
  return (
    <Conversation>
      {/* Width cap lives here, inside the scroller, so the scrollbar stays at
          the panel edge instead of hugging the centered column. */}
      <ConversationContent
        scrollClassName="scrollbar-thin"
        className="mx-auto w-full max-w-4xl min-w-80"
      >
        {snapshot.messages.length === 0 && (
          <EmptyTranscript historyStatus={snapshot.historyStatus} />
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
