import type { ChatStatus, UIMessage } from "ai";
import { createStore, type StoreApi } from "zustand/vanilla";

import type { AgentRequest } from "./agent-requests";
import type { ChatState, HistoryStatus } from "./chat-state";

// The complete snapshot React renders. It is derived from ChatState and never
// used by the runtime to make protocol or queue decisions.
export type ChatView = {
  messages: UIMessage[];
  queuedMessages: UIMessage[];
  status: ChatStatus;
  error: Error | undefined;
  pendingRequests: AgentRequest[];
  historyStatus: HistoryStatus;
};

export function buildChatView(state: ChatState): ChatView {
  return {
    messages: state.session.messages,
    queuedMessages: state.outgoing
      .filter((message) => message.status === "queued")
      .map((message) => message.message),
    status: state.status,
    error: state.error,
    pendingRequests: state.session.pendingRequests,
    historyStatus: state.session.historyStatus,
  };
}

// Zustand is only the publication mechanism. Chat owns business state and
// publishes one complete view after each state update.
export class ChatViewStore {
  readonly store: StoreApi<ChatView>;

  constructor(initialView: ChatView) {
    this.store = createStore<ChatView>()(() => initialView);
  }

  publish(view: ChatView): void {
    this.store.setState(view, true);
  }
}
