import type { HarnessAgentId } from "@vibest/contract";
import { AbstractChat, type UIMessage } from "ai";
import type { StoreApi } from "zustand/vanilla";

import type { AgentResponse } from "./agent-requests";
import { ChatState, type ChatStoreState } from "./chat-state";
import type { ChatModel, OrpcChatSessionTransport } from "./chat-transport";

export interface ChatInit {
  sessionId: string;
  harnessAgentId: HarnessAgentId;
  transport: OrpcChatSessionTransport;
}

// Session controller: AbstractChat drives the prompt stream (optimistic user
// push, chunk reduction, status transitions) against a per-Chat zustand store;
// the agent-request plane arrives over the same Vibest session transport.
export class Chat extends AbstractChat<UIMessage> {
  // A Chat is bound to one harness for its whole life (a session's harness
  // never changes), so tool rendering dispatches on it. Only claude-code and
  // codex have dedicated renderers; any other harness falls back to the
  // generic tool card.
  readonly harnessAgentId: HarnessAgentId;
  readonly store: StoreApi<ChatStoreState>;
  readonly #state: ChatState;
  readonly #transport: OrpcChatSessionTransport;
  readonly #unsubscribeRequests: () => void;

  constructor({ sessionId, harnessAgentId, transport }: ChatInit) {
    const state = new ChatState();
    super({
      id: sessionId,
      transport,
      state,
      // Turn ended: unanswered requests are stale — drop them so no ghost card
      // lingers in the transcript.
      onFinish: () => state.clearPendingRequests(),
    });
    this.harnessAgentId = harnessAgentId;
    this.store = state.store;
    this.#state = state;
    this.#transport = transport;
    this.#unsubscribeRequests = transport.subscribeAgentRequests(
      sessionId,
      (request) => state.addPendingRequest(request),
      (requestId) => state.removePendingRequest(requestId),
    );
  }

  prompt = async (text: string, options?: { model?: ChatModel }): Promise<void> => {
    await this.sendMessage({ text }, { body: { model: options?.model } });
  };

  respondToAgentRequest = async (requestId: string, response: AgentResponse): Promise<void> => {
    const request = this.store.getState().pendingRequests.find((r) => r.id === requestId);
    this.#state.removePendingRequest(requestId); // optimistic: the card closes immediately
    try {
      await this.#transport.respondToAgentRequest(this.id, requestId, response);
    } catch (respondError) {
      // Failure = the request is still pending server-side: restore the card so
      // the user can answer again (addPendingRequest is idempotent by id).
      console.error("Failed to respond to agent request", respondError);
      if (request) this.#state.addPendingRequest(request);
    }
  };

  dispose = (): void => {
    this.#unsubscribeRequests();
  };
}
