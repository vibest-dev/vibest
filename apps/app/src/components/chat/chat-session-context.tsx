import { createContext, useContext, useState, type ReactNode } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";

import type { AgentResponse } from "@/core/chat/agent-requests";
import type { AgentProviderId } from "@/core/chat/chat";
import type { ChatStoreState } from "@/core/chat/chat-state";
import type { ChatModel } from "@/core/chat/chat-transport";
import { selectTurnInProgress, useChatHandle } from "@/core/chat/use-chat-handle";

export type { ChatModel };

export interface ChatSessionValue {
  sessionId: string;
  agentProviderId: AgentProviderId;
  /** Per-Chat store. Consumers subscribe narrowly via useStore(store, selector). */
  store: StoreApi<ChatStoreState>;
  prompt: (text: string) => void | Promise<void>;
  respondToRequest: (requestId: string, response: AgentResponse) => void | Promise<void>;
  /** A turn is producing a reply (submitted / streaming). */
  turnInProgress: boolean;
  model: ChatModel;
  setModel: (model: ChatModel) => void;
}

const ChatSessionContext = createContext<ChatSessionValue | null>(null);

export function useChatSession(): ChatSessionValue {
  const value = useContext(ChatSessionContext);
  if (!value) throw new Error("useChatSession must be used within ChatSessionProvider");
  return value;
}

// The only place that holds the sessionId: attaches the Chat once via the
// manager and provides the handle plus session-scoped config (model) to peer
// components (ChatTranscript / ChatInputComposer / ChatModelSelect). Chat
// state lives in the per-Chat store, not in React — it survives unmounts.
export function ChatSessionProvider({
  sessionId,
  children,
}: {
  sessionId: string;
  children: ReactNode;
}) {
  const chat = useChatHandle(sessionId);
  const [model, setModel] = useState<ChatModel>("sonnet");
  const turnInProgress = useStore(chat.store, selectTurnInProgress);

  const value: ChatSessionValue = {
    sessionId,
    agentProviderId: chat.agentProviderId,
    store: chat.store,
    prompt: (text) => chat.prompt(text, { model }),
    respondToRequest: chat.respondToAgentRequest,
    turnInProgress,
    model,
    setModel,
  };

  return <ChatSessionContext.Provider value={value}>{children}</ChatSessionContext.Provider>;
}
