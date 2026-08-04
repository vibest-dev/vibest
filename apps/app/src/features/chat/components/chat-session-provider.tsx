import type { PermissionMode, ProviderInfo, ReasoningEffort, SessionRef } from "@vibest/contract";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useStore } from "zustand";

import { orderPermissionModes } from "@/features/chat/harness/permission-modes";
import {
  findModelInfo,
  resolveReasoningEffort,
  resolveModel,
  resolvePermissionMode,
} from "@/features/chat/harness/session-config";
import { useHarnessAgent, useHarnessProbe } from "@/features/chat/harness/use-harness";
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
  const probe = useHarnessProbe(chat.harnessAgentId, cwd);
  const providers = probe.data?.providers ?? NO_PROVIDERS;
  // Each dimension resolves on its own; reasoningEffort cascades from the resolved model.
  const model = resolveModel(providers, picked.providerId, picked.modelId);
  const modelInfo = findModelInfo(providers, model?.providerId, model?.modelId);
  const turnInProgress = useStore(chat.store, selectTurnInProgress);

  // Config changes are separate session calls, applied optimistically to the
  // local picks so the control stays responsive.
  const setModel = useCallback(
    (providerId: string, modelId: string) => {
      // Mirrors the server: switching models drops the reasoningEffort override, so the
      // new model runs on its own default until the user picks again.
      setPicked(({ reasoningEffort: _dropped, ...current }) => ({
        ...current,
        providerId,
        modelId,
      }));
      void chat
        .setModel(providerId, modelId)
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
  // the harness's declared list — which only changes when the probe does.
  const declaredPermissionModes = harnessAgent?.permissionModes;
  const permissionModes = useMemo(
    () => orderPermissionModes(declaredPermissionModes ?? []),
    [declaredPermissionModes],
  );
  const providerId = model?.providerId;
  const modelId = model?.modelId;
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
