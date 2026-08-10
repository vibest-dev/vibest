import type { HarnessAgentId, PermissionMode, ReasoningEffort, SessionRef } from "@vibest/contract";
import type { StoreApi } from "zustand/vanilla";

import type { AgentResponse } from "./agent-requests";
import { ChatRuntime } from "./chat-runtime";
import type { ChatState } from "./chat-state";
import type { ChatSessionTransport } from "./chat-transport-port";

export interface ChatInit {
  readonly sessionRef: SessionRef;
  readonly transport: ChatSessionTransport;
  readonly onTerminated?: () => void;
}

/**
 * Stable interface used by React and ChatManager. All state synchronization,
 * queueing and recovery live behind the serialized ChatRuntime.
 */
export class Chat {
  readonly harnessAgentId: HarnessAgentId;
  readonly store: StoreApi<ChatState>;
  readonly #runtime: ChatRuntime;

  constructor(init: ChatInit) {
    this.#runtime = new ChatRuntime(init);
    this.harnessAgentId = this.#runtime.harnessAgentId;
    this.store = this.#runtime.store;
  }

  prompt = (text: string): Promise<void> => this.#runtime.prompt(text);

  steer = (messageId: string): void => this.#runtime.steer(messageId);

  acknowledgeRecovery = (recoveryId: string): Promise<void> =>
    this.#runtime.acknowledgeRecovery(recoveryId);

  setModel = (providerId: string, modelId: string): Promise<void> =>
    this.#runtime.setModel(providerId, modelId);

  setReasoningEffort = (reasoningEffort: ReasoningEffort): Promise<void> =>
    this.#runtime.setReasoningEffort(reasoningEffort);

  setPermissionMode = (mode: PermissionMode): Promise<void> =>
    this.#runtime.setPermissionMode(mode);

  respondToAgentRequest = (requestId: string, response: AgentResponse): Promise<void> =>
    this.#runtime.respondToAgentRequest(requestId, response);

  dispose = (): void => this.#runtime.dispose();
}
