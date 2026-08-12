import { Loader } from "@vibest/ui/ai-elements/loader";
import { Shimmer } from "@vibest/ui/ai-elements/shimmer";
import { useStore } from "zustand";

import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/conversation";
import type { HistoryStatus } from "@/features/chat/runtime/chat-state";

import { useChatSession } from "./chat-session-context";
import { AgentRequestView } from "./transcript/agent-request";
import { MessageView } from "./transcript/message-view";
import { TranscriptRenderProvider } from "./transcript/transcript-render-provider";

function EmptyTranscript({ historyStatus }: { historyStatus: HistoryStatus }) {
  if (historyStatus === "loading") {
    return <Shimmer className="text-sm">Loading earlier messages…</Shimmer>;
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

export function ChatTranscript() {
  const { store, harnessAgentId, respondToRequest } = useChatSession();
  const messages = useStore(store, (state) => state.session.messages);
  const status = useStore(store, (state) => state.session.status);
  const error = useStore(store, (state) => state.session.error);
  const pendingRequests = useStore(store, (state) => state.session.pendingRequests);
  const historyStatus = useStore(store, (state) => state.session.historyStatus);
  const lastIndex = messages.length - 1;
  const turnInProgress = status === "submitted" || status === "streaming";

  return (
    <TranscriptRenderProvider harnessAgentId={harnessAgentId}>
      <Conversation>
        <ConversationContent
          scrollClassName="scrollbar-thin"
          className="mx-auto w-full max-w-4xl min-w-80"
        >
          {messages.length === 0 && <EmptyTranscript historyStatus={historyStatus} />}
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
    </TranscriptRenderProvider>
  );
}
