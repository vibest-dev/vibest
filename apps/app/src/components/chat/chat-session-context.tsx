import type { HarnessAgentId, SessionRef } from "@vibest/contract";
import { createContext, useContext, useState, type ReactNode } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";

import type { AgentResponse } from "@/core/chat/agent-requests";
import type { ChatModel, ChatPermissionMode } from "@/core/chat/chat-config";
import type { ChatStoreState } from "@/core/chat/chat-state";
import { selectTurnInProgress, useChatHandle } from "@/core/chat/use-chat-handle";
import {
  resolveSessionConfig,
  type SessionConfigOption,
  type SessionConfigSelection,
} from "@/core/harness/session-config";
import { useHarnessAgent, useHarnessCatalog } from "@/core/harness/use-harness-negotiation";
import { useProjectPath } from "@/core/harness/use-project-path";

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
  /** The harness's model catalog; empty when it has no model switch. */
  models: ReadonlyArray<SessionConfigOption>;
  model: ChatModel | undefined;
  setModel: (model: ChatModel) => void;
  /** The harness's permission presets; empty when it has no permission protocol. */
  permissionModes: ReadonlyArray<SessionConfigOption>;
  permissionMode: ChatPermissionMode | undefined;
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
  // Only what the user changed in this session lives in state; anything unset
  // follows the harness's declared default. Session config isn't persisted yet
  // (see docs/design/harness-agent-selection-design.md §7), so after a reload
  // these show the harness defaults rather than what the session actually runs
  // with — but never a value the harness doesn't offer.
  const [selection, setSelection] = useState<SessionConfigSelection>({});
  const harnessAgent = useHarnessAgent(chat.harnessAgentId);
  // What this harness offers *in this session's directory* — a project's own
  // settings can remap what a model id resolves to, so the catalog has to be
  // asked for per project, not once per harness.
  const cwd = useProjectPath(sessionRef.projectId);
  const catalog = useHarnessCatalog(chat.harnessAgentId, cwd);
  const config = resolveSessionConfig(harnessAgent, catalog, selection);
  const turnInProgress = useStore(chat.store, selectTurnInProgress);

  // Config changes are a separate session call, applied optimistically to the
  // local selection so the control stays responsive.
  const setModel = (next: ChatModel) => {
    setSelection((current) => ({ ...current, model: next }));
    void chat.setModel(next).catch((error) => console.error("Failed to set model", error));
  };
  const setPermissionMode = (next: ChatPermissionMode) => {
    setSelection((current) => ({ ...current, permissionMode: next }));
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
    models: config.models,
    model: config.model,
    setModel,
    permissionModes: config.permissionModes,
    permissionMode: config.permissionMode,
    setPermissionMode,
  };

  return <ChatSessionContext.Provider value={value}>{children}</ChatSessionContext.Provider>;
}
