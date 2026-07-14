import type { ChatState as AiChatState, ChatStatus, UIMessage } from "ai";
import { createStore, type StoreApi } from "zustand/vanilla";

import type { AgentRequest } from "./agent-requests";

// Each Chat owns its own store: messages + status + error + pendingRequests.
export type ChatStoreState = {
  messages: UIMessage[];
  status: ChatStatus;
  error?: Error;
  pendingRequests: AgentRequest[];
};

// The ChatState interface AbstractChat requires, backed by the per-Chat store
// (no global store, no adapter).
export class ChatState implements AiChatState<UIMessage> {
  readonly store: StoreApi<ChatStoreState>;

  constructor(initialMessages: UIMessage[] = []) {
    this.store = createStore<ChatStoreState>()(() => ({
      messages: initialMessages,
      status: "ready",
      error: undefined,
      pendingRequests: [],
    }));
  }

  get messages(): UIMessage[] {
    return this.store.getState().messages;
  }
  set messages(messages: UIMessage[]) {
    this.store.setState({ messages });
  }

  get status(): ChatStatus {
    return this.store.getState().status;
  }
  set status(status: ChatStatus) {
    this.store.setState({ status });
  }

  get error(): Error | undefined {
    return this.store.getState().error;
  }
  set error(error: Error | undefined) {
    this.store.setState({ error });
  }

  pushMessage = (message: UIMessage) => {
    this.store.setState((s) => ({ messages: [...s.messages, message] }));
  };
  popMessage = () => {
    this.store.setState((s) => ({ messages: s.messages.slice(0, -1) }));
  };
  replaceMessage = (index: number, message: UIMessage) => {
    this.store.setState((s) => {
      const next = s.messages.slice();
      // AbstractChat's stream reduction mutates one message object in place and
      // calls replaceMessage with that same reference on every chunk. Clone on
      // write so each update carries fresh part identities — otherwise memos
      // keyed on `message.parts` never recompute (same as ReactChatState).
      next[index] = this.snapshot(message);
      return { messages: next };
    });
  };
  snapshot = <T>(value: T): T => structuredClone(value);

  // Pending agent requests (cleared when the turn ends).
  addPendingRequest = (request: AgentRequest) => {
    this.store.setState((s) => ({
      pendingRequests: s.pendingRequests.some((r) => r.id === request.id)
        ? s.pendingRequests.map((r) => (r.id === request.id ? request : r))
        : [...s.pendingRequests, request],
    }));
  };
  removePendingRequest = (requestId: string) => {
    this.store.setState((s) => ({
      pendingRequests: s.pendingRequests.filter((r) => r.id !== requestId),
    }));
  };
  clearPendingRequests = () => {
    this.store.setState({ pendingRequests: [] });
  };
}
