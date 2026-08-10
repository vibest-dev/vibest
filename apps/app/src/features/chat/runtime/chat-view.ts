import type { ChatStatus, UIMessage } from "ai";
import { createStore, type StoreApi } from "zustand/vanilla";

import type { AgentRequest } from "./agent-requests";
import type { ChatState, HistoryStatus } from "./chat-state";

export type ChatView = {
  messages: UIMessage[];
  queuedMessages: UIMessage[];
  status: ChatStatus;
  error: Error | undefined;
  pendingRequests: AgentRequest[];
  historyStatus: HistoryStatus;
};

export function buildChatView(state: ChatState): ChatView {
  const queuedMessages: UIMessage[] = [];
  for (const outgoing of state.outgoing) {
    if (outgoing.status === "queued") queuedMessages.push(outgoing.message);
  }
  return {
    messages: state.session.messages,
    queuedMessages,
    status: state.session.status,
    error: state.session.error,
    pendingRequests: state.session.pendingRequests,
    historyStatus: state.session.historyStatus,
  };
}

export class ChatViewStore {
  readonly store: StoreApi<ChatView>;

  constructor(initialView: ChatView) {
    this.store = createStore<ChatView>()(() => initialView);
  }

  publish(view: ChatView): void {
    this.store.setState(view, true);
  }
}
