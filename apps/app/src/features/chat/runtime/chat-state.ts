import type { ChatState as AiChatState, ChatStatus, UIMessage } from "ai";
import { createStore, type StoreApi } from "zustand/vanilla";

import type { AgentRequest } from "./agent-requests";

// Where the settled-history floor stands. A Chat is born "loading", so an empty
// transcript means "not read yet" rather than "nothing was ever said"; only
// once the floor lands does an empty transcript mean the session really is
// empty. "unavailable" covers both ways the read can come back with nothing to
// lay down — the harness has no history read, or the read failed — which are
// the same fact to a reader: the transcript starts here, the agent's own
// context does not.
export type HistoryStatus = "loading" | "settled" | "unavailable";

// Each Chat owns its own store. Queued messages stay separate from the
// transcript: settled-history reconciliation may replace `messages`, but it
// must never erase prompts that have not been submitted to the server yet.
export type ChatStoreState = {
  messages: UIMessage[];
  queuedMessages: UIMessage[];
  status: ChatStatus;
  error?: Error;
  pendingRequests: AgentRequest[];
  historyStatus: HistoryStatus;
};

// The slice of ai-sdk's ChatState this runtime still honors — the shared data
// vocabulary (messages/status/error) plus the append and snapshot primitives.
// The index-addressed mutators are omitted deliberately: under multi-client
// reconcile the transcript is rewritten wholesale, so indexes are unstable and
// replacement is id-based (upsertMessage). Implementing the remainder keeps
// this state pinned to the ai-sdk shape — drift in `ai` fails typecheck here.
type AiChatStateSlice = Omit<AiChatState<UIMessage>, "popMessage" | "replaceMessage">;

// Chat's state container, backed by the per-Chat store (no global store, no
// adapter).
export class ChatState implements AiChatStateSlice {
  readonly store: StoreApi<ChatStoreState>;

  constructor(initialMessages: UIMessage[] = []) {
    this.store = createStore<ChatStoreState>()(() => ({
      messages: initialMessages,
      queuedMessages: [],
      status: "ready",
      error: undefined,
      pendingRequests: [],
      historyStatus: "loading",
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

  get historyStatus(): HistoryStatus {
    return this.store.getState().historyStatus;
  }
  set historyStatus(historyStatus: HistoryStatus) {
    this.store.setState({ historyStatus });
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
  // Replace-by-id or append: the turn folds produce message snapshots that
  // evolve under a stable id, and the reducer mutates one message object in
  // place across chunks. Clone on write so each update carries fresh part
  // identities — otherwise memos keyed on `message.parts` never recompute.
  upsertMessage = (message: UIMessage) => {
    this.store.setState((s) => {
      const index = s.messages.findIndex((m) => m.id === message.id);
      const next = s.messages.slice();
      if (index === -1) next.push(this.snapshot(message));
      else next[index] = this.snapshot(message);
      return { messages: next };
    });
  };
  snapshot = <T>(value: T): T => structuredClone(value);

  setQueuedMessages = (queuedMessages: UIMessage[]) => {
    this.store.setState({ queuedMessages });
  };

  // Pending agent requests (cleared when the turn ends). The server owns this
  // state: a snapshot hydration replaces the list wholesale, live events add
  // and remove.
  setPendingRequests = (pendingRequests: AgentRequest[]) => {
    this.store.setState({ pendingRequests });
  };
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
