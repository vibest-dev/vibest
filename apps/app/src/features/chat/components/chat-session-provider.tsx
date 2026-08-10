import type { PermissionMode, ProviderInfo, ReasoningEffort, SessionRef } from "@vibest/contract";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useStore } from "zustand";

import { orderPermissionModes } from "@/features/chat/harness/permission-modes";
import {
  findModelInfo,
  resolveReasoningEffort,
  resolvePermissionMode,
} from "@/features/chat/harness/session-config";
import { useHarnessAgent, useHarnessModels } from "@/features/chat/harness/use-harness";
import { selectTurnInProgress, useChatHandle } from "@/features/chat/runtime/use-chat-handle";

import { ChatSessionContext, type ChatSessionValue } from "./chat-session-context";

// Shared empty tails so "the harness offers no such dimension" is one identity
// rather than a fresh array per render, which would defeat the memo below.
const NO_PROVIDERS: ReadonlyArray<ProviderInfo> = [];
const NO_REASONING_EFFORTS: ReadonlyArray<ReasoningEffort> = [];

// The only place that holds the sessionId: attaches the Chat once via the
// manager and provides the handle plus session-scoped config (model) to peer
// components (ChatTranscript / ChatInputComposer / ChatModelSelect). Chat
// state lives in the per-Chat store, not in React — it survives unmounts.
export function ChatSessionProvider({
  sessionRef,
  cwd,
  children,
}: {
  sessionRef: SessionRef;
  /** The session's working directory — resolved by the route, see `Chat`. */
  cwd: string | undefined;
  children: ReactNode;
}) {
  const chat = useChatHandle(sessionRef);
  const [picked, setPicked] = useState<{
    reasoningEffort?: ReasoningEffort;
    permissionMode?: PermissionMode;
  }>({});
  const harnessAgent = useHarnessAgent(chat.harnessAgentId);
  const turnInProgress = useStore(chat.store, selectTurnInProgress);
  const providerId = useStore(chat.store, (state) => state.providerId);
  const modelId = useStore(chat.store, (state) => state.modelId);
  const historyStatus = useStore(chat.store, (state) => state.historyStatus);
  // A live session answers through its current runtime. A cold session falls
  // back to the directory-aware model list without starting the managed
  // session solely for this control. Turn transitions force the cold answer to
  // be replaced once the first runtime exists.
  const {
    data: modelData,
    isError: modelListFailed,
    refetch: refetchModels,
  } = useHarnessModels(
    chat.harnessAgentId,
    historyStatus === "loading" ? undefined : cwd,
    sessionRef,
    turnInProgress,
  );
  const providers = modelData?.providers ?? NO_PROVIDERS;
  const retryModelList = useCallback(() => {
    void refetchModels();
  }, [refetchModels]);
  // The snapshot/event stream owns the pair. The catalog only enriches it
  // with display data and normalized traits; a missing row never erases the
  // session's stored selection.
  const modelInfo = findModelInfo(providers, providerId, modelId);

  const setModel = useCallback(
    (nextProviderId: string, nextModelId: string) => {
      setPicked(({ reasoningEffort: _dropped, ...current }) => current);
      // The session event is authoritative. Avoid optimistic model writes so
      // an older failed request cannot roll back a newer event or selection.
      void chat
        .setModel(nextProviderId, nextModelId)
        .catch((error) => console.error("Failed to set model", error));
    },
    [chat],
  );
  const setReasoningEffort = useCallback(
    (next: ReasoningEffort) => {
      setPicked((current) => ({ ...current, reasoningEffort: next }));
      void chat
        .setReasoningEffort(next)
        .catch((error) => console.error("Failed to set reasoningEffort", error));
    },
    [chat],
  );
  const setPermissionMode = useCallback(
    (next: PermissionMode) => {
      setPicked((current) => ({ ...current, permissionMode: next }));
      void chat
        .setPermissionMode(next)
        .catch((error) => console.error("Failed to set permission mode", error));
    },
    [chat],
  );
  const prompt = useCallback((text: string) => chat.prompt(text), [chat]);

  const reasoningEfforts = modelInfo?.reasoningEfforts ?? NO_REASONING_EFFORTS;
  // orderPermissionModes builds a new array on every call, so it is memoised on
  // the harness's declared list — which only changes when model data changes.
  const declaredPermissionModes = harnessAgent?.permissionModes;
  const permissionModes = useMemo(
    () => orderPermissionModes(declaredPermissionModes ?? []),
    [declaredPermissionModes],
  );
  const reasoningEffort = resolveReasoningEffort(modelInfo, picked.reasoningEffort);
  const permissionMode = resolvePermissionMode(harnessAgent, picked.permissionMode);

  // Every consumer of this context re-renders whenever the value's identity
  // changes, and this provider wraps the whole chat surface — so the value is
  // memoised on its fields.
  const value = useMemo<ChatSessionValue>(
    () => ({
      sessionId: sessionRef.sessionId,
      harnessAgentId: chat.harnessAgentId,
      store: chat.store,
      prompt,
      respondToRequest: chat.respondToAgentRequest,
      turnInProgress,
      providers,
      modelListFailed,
      retryModelList,
      providerId,
      modelId,
      setModel,
      reasoningEfforts,
      reasoningEffort,
      setReasoningEffort,
      permissionModes,
      permissionMode,
      setPermissionMode,
    }),
    [
      sessionRef.sessionId,
      chat,
      prompt,
      turnInProgress,
      providers,
      modelListFailed,
      retryModelList,
      providerId,
      modelId,
      setModel,
      reasoningEfforts,
      reasoningEffort,
      setReasoningEffort,
      permissionModes,
      permissionMode,
      setPermissionMode,
    ],
  );

  return <ChatSessionContext.Provider value={value}>{children}</ChatSessionContext.Provider>;
}
