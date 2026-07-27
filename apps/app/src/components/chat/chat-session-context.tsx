import type {
  HarnessAgentId,
  PermissionMode,
  ProviderInfo,
  ReasoningEffort,
  SessionRef,
} from "@vibest/contract";
import { createContext, useContext, useState, type ReactNode } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";

import type { AgentResponse } from "@/core/chat/agent-requests";
import type { ChatStoreState } from "@/core/chat/chat-state";
import { selectTurnInProgress, useChatHandle } from "@/core/chat/use-chat-handle";
import { orderPermissionModes } from "@/core/harness/permission-modes";
import {
  findModelInfo,
  resolveReasoningEffort,
  resolveModel,
  resolvePermissionMode,
} from "@/core/harness/session-config";
import { useHarnessAgent, useHarnessProbe } from "@/core/harness/use-harness";
import { useProjectPath } from "@/core/harness/use-project-path";

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
  const [picked, setPicked] = useState<{
    providerId?: string;
    modelId?: string;
    reasoningEffort?: ReasoningEffort;
    permissionMode?: PermissionMode;
  }>({});
  const harnessAgent = useHarnessAgent(chat.harnessAgentId);
  // What this harness offers *in this session's directory* — a project's own
  // settings can remap what a model id resolves to, so the providers have to
  // be probed per project, not once per harness.
  const cwd = useProjectPath(sessionRef.projectId);
  const probe = useHarnessProbe(chat.harnessAgentId, cwd);
  const providers = probe.data?.providers ?? [];
  // Each dimension resolves on its own; reasoningEffort cascades from the resolved model.
  const model = resolveModel(providers, picked.providerId, picked.modelId);
  const modelInfo = findModelInfo(providers, model?.providerId, model?.modelId);
  const turnInProgress = useStore(chat.store, selectTurnInProgress);

  // Config changes are separate session calls, applied optimistically to the
  // local picks so the control stays responsive.
  const setModel = (providerId: string, modelId: string) => {
    // Mirrors the server: switching models drops the reasoningEffort override, so the
    // new model runs on its own default until the user picks again.
    setPicked(({ reasoningEffort: _dropped, ...current }) => ({ ...current, providerId, modelId }));
    void chat
      .setModel(providerId, modelId)
      .catch((error) => console.error("Failed to set model", error));
  };
  const setReasoningEffort = (next: ReasoningEffort) => {
    setPicked((current) => ({ ...current, reasoningEffort: next }));
    void chat
      .setReasoningEffort(next)
      .catch((error) => console.error("Failed to set reasoningEffort", error));
  };
  const setPermissionMode = (next: PermissionMode) => {
    setPicked((current) => ({ ...current, permissionMode: next }));
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
    providers,
    providerId: model?.providerId,
    modelId: model?.modelId,
    setModel,
    reasoningEfforts: modelInfo?.reasoningEfforts ?? [],
    reasoningEffort: resolveReasoningEffort(modelInfo, picked.reasoningEffort),
    setReasoningEffort,
    permissionModes: orderPermissionModes(harnessAgent?.permissionModes ?? []),
    permissionMode: resolvePermissionMode(harnessAgent, picked.permissionMode),
    setPermissionMode,
  };

  return <ChatSessionContext.Provider value={value}>{children}</ChatSessionContext.Provider>;
}
