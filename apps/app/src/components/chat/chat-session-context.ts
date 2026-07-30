import type {
  HarnessAgentId,
  PermissionMode,
  ProviderInfo,
  ReasoningEffort,
} from "@vibest/contract";
import { createContext, useContext } from "react";
import type { StoreApi } from "zustand/vanilla";

import type { AgentResponse } from "@/core/chat/agent-requests";
import type { ChatStoreState } from "@/core/chat/chat-state";

export interface ChatSessionValue {
  sessionId: string;
  harnessAgentId: HarnessAgentId;
  /** Per-Chat store. Consumers subscribe narrowly via useStore(store, selector). */
  store: StoreApi<ChatStoreState>;
  prompt: (text: string) => void | Promise<void>;
  respondToRequest: (requestId: string, response: AgentResponse) => void | Promise<void>;
  /** A turn is producing a reply (submitted / streaming). */
  turnInProgress: boolean;
  /** Probed model providers; empty when the harness has no model switch. */
  providers: ReadonlyArray<ProviderInfo>;
  /** The selected model pair — always both or neither. */
  providerId: string | undefined;
  modelId: string | undefined;
  setModel: (providerId: string, modelId: string) => void;
  /** ReasoningEffort candidates of the selected model; empty when it has no reasoningEffort switch. */
  reasoningEfforts: ReadonlyArray<ReasoningEffort>;
  reasoningEffort: ReasoningEffort | undefined;
  setReasoningEffort: (reasoningEffort: ReasoningEffort) => void;
  /** The harness's declared permission subset; empty when it has no permission protocol. */
  permissionModes: ReadonlyArray<PermissionMode>;
  permissionMode: PermissionMode | undefined;
  setPermissionMode: (mode: PermissionMode) => void;
}

export const ChatSessionContext = createContext<ChatSessionValue | null>(null);

export function useChatSession(): ChatSessionValue {
  const value = useContext(ChatSessionContext);
  if (!value) throw new Error("useChatSession must be used within ChatSessionProvider");
  return value;
}
