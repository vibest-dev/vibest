import { AbstractChat, type UIMessage } from "ai";
import type { StoreApi } from "zustand/vanilla";

import type { AgentResponse } from "./agent-requests";
import { ChatState, type ChatStoreState } from "./chat-state";
import type { ChatModel, ChatTransport } from "./chat-transport";

export type AgentProviderId = "claude-code";

export interface ChatInit {
  sessionId: string;
  transport: ChatTransport;
}

// Provider-agnostic session controller: AbstractChat drives the prompt stream
// (optimistic user push, chunk reduction, status transitions) against a
// per-Chat zustand store; the agent-request plane arrives over the transport
// subscription. Provider detail stays inside ChatTransport.
export class Chat extends AbstractChat<UIMessage> {
  readonly agentProviderId: AgentProviderId = "claude-code";
  readonly store: StoreApi<ChatStoreState>;
  readonly #state: ChatState;
  readonly #transport: ChatTransport;
  readonly #unsubscribeRequests: () => void;

  constructor({ sessionId, transport }: ChatInit) {
    const state = new ChatState();
    super({
      id: sessionId,
      transport,
      state,
      // Turn ended: unanswered requests are stale — drop them so no ghost card
      // lingers in the transcript.
      onFinish: () => state.clearPendingRequests(),
    });
    this.store = state.store;
    this.#state = state;
    this.#transport = transport;
    this.#unsubscribeRequests = transport.subscribeAgentRequests(sessionId, (request) =>
      state.addPendingRequest(request),
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
