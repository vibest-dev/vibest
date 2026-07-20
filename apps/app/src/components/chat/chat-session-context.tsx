import type { HarnessAgentId, SessionRef } from "@vibest/contract";
import { createContext, useContext, useState, type ReactNode } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";

import type { AgentResponse } from "@/core/chat/agent-requests";
import type { ChatModel, ChatPermissionMode } from "@/core/chat/chat-config";
import type { ChatStoreState } from "@/core/chat/chat-state";
import { selectTurnInProgress, useChatHandle } from "@/core/chat/use-chat-handle";

export type { ChatModel, ChatPermissionMode };

export interface ChatSessionValue {
  sessionId: string;
  harnessAgentId: HarnessAgentId;
  /** Per-Chat store. Consumers subscribe narrowly via useStore(store, selector). */
  store: StoreApi<ChatStoreState>;
  prompt: (text: string) => void | Promise<void>;
  respondToRequest: (requestId: string, response: AgentResponse) => void | Promise<void>;
  /** A turn is producing a reply (submitted / streaming). */
  turnInProgress: boolean;
  model: ChatModel;
  setModel: (model: ChatModel) => void;
  permissionMode: ChatPermissionMode;
  setPermissionMode: (mode: ChatPermissionMode) => void;
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
  sessionRef,
  children,
}: {
  sessionRef: SessionRef;
  children: ReactNode;
}) {
  const chat = useChatHandle(sessionRef);
  const [model, setModelState] = useState<ChatModel>("sonnet");
  // Matches the draft surface's default (claude-code's "full" → bypassPermissions).
  const [permissionMode, setPermissionModeState] = useState<ChatPermissionMode>("full");
  const turnInProgress = useStore(chat.store, selectTurnInProgress);

  // Config changes are a separate session call, applied optimistically to the
  // local selection so the control stays responsive.
  const setModel = (next: ChatModel) => {
    setModelState(next);
    void chat.setModel(next).catch((error) => console.error("Failed to set model", error));
  };
  const setPermissionMode = (next: ChatPermissionMode) => {
    setPermissionModeState(next);
    void chat
      .setPermissionMode(next)
      .catch((error) => console.error("Failed to set permission mode", error));
  };

  const value: ChatSessionValue = {
    sessionId: sessionRef.sessionId,
    harnessAgentId: chat.harnessAgentId,
    store: chat.store,
    prompt: (text) => chat.prompt(text),
    respondToRequest: chat.respondToAgentRequest,
    turnInProgress,
    model,
    setModel,
    permissionMode,
    setPermissionMode,
  };

  return <ChatSessionContext.Provider value={value}>{children}</ChatSessionContext.Provider>;
}
