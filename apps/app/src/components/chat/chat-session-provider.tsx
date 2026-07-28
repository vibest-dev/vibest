import type { PermissionMode, ReasoningEffort, SessionRef } from "@vibest/contract";
import { useState, type ReactNode } from "react";
import { useStore } from "zustand";

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

import { ChatSessionContext, type ChatSessionValue } from "./chat-session-context";

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
