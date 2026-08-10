import type { PromptPart } from "@vibest/contract";
import type { ChatStatus, UIMessage } from "ai";

import type { AgentRequest } from "./agent-requests";

// Where the settled-history floor stands. A Chat is born "loading", so an
// empty transcript means "not read yet" rather than "nothing was ever said".
export type HistoryStatus = "loading" | "settled" | "unavailable";

export type SessionState = {
  messages: UIMessage[];
  pendingRequests: AgentRequest[];
  historyStatus: HistoryStatus;
};

export type OutgoingMessage = {
  readonly message: UIMessage;
  readonly parts: ReadonlyArray<PromptPart>;
  readonly status: "queued" | "sending";
};

export type ChatLifecycle = {
  session: "available" | "terminated";
  instance: "active" | "disposed";
};

// The runtime's single source of truth for user-observable chat state. Protocol
// synchronization details such as cursors and attach buffering still belong to
// Chat; they move here only once their whole state machine can move together.
export type ChatState = {
  session: SessionState;
  outgoing: OutgoingMessage[];
  status: ChatStatus;
  error: Error | undefined;
  lifecycle: ChatLifecycle;
};

export function createChatState(initialMessages: UIMessage[] = []): ChatState {
  return {
    session: {
      messages: initialMessages,
      pendingRequests: [],
      historyStatus: "loading",
    },
    outgoing: [],
    status: "ready",
    error: undefined,
    lifecycle: { session: "available", instance: "active" },
  };
}
