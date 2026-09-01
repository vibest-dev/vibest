import type { SessionRuntimeSnapshot, SessionScopedEvent } from "@vibest/contract";

import type { ChatDraft, ChatEffects, ChatInput } from "./chat-runtime-types";
import { isChatActive } from "./chat-state";
import { hasClosingFolds, hasFolds } from "./chat-turn";

export function startHistoryFloor(
  state: ChatDraft,
  effects: ChatEffects,
  snapshot: SessionRuntimeSnapshot,
): void {
  const id = state.nextOperationId;
  state.nextOperationId += 1;
  state.sync.historyLoaded = true;
  state.sync.floor = { id, snapshot, events: [] };
  effects.push({ type: "readHistory", id, purpose: "floor" });
}

export function startReconcile(state: ChatDraft, effects: ChatEffects): void {
  if (
    !isChatActive(state) ||
    !state.sync.needsReconcile ||
    state.sync.floor !== null ||
    state.sync.reconcile !== null ||
    state.outgoing.some(
      (message) => message.delivery === "follow-up" && message.status === "sending",
    ) ||
    hasClosingFolds(state)
  ) {
    return;
  }
  const id = state.nextOperationId;
  state.nextOperationId += 1;
  state.sync.reconcile = { id, promptRevision: state.prompt.revision };
  effects.push({ type: "readHistory", id, purpose: "reconcile" });
}

type HistoryRecovery = {
  readonly hydrateSnapshot: (
    state: ChatDraft,
    effects: ChatEffects,
    snapshot: SessionRuntimeSnapshot,
    skipGapCheck: boolean,
  ) => void;
  readonly applyEvent: (state: ChatDraft, effects: ChatEffects, event: SessionScopedEvent) => void;
};

export function handleHistoryCompleted(
  state: ChatDraft,
  effects: ChatEffects,
  input: Extract<ChatInput, { type: "historyCompleted" }>,
  recovery: HistoryRecovery,
): boolean {
  if (input.purpose === "floor") {
    const floor = state.sync.floor;
    if (!floor || floor.id !== input.id) return false;
    if (input.error !== undefined) {
      state.session.historyStatus = "unavailable";
      effects.push({
        type: "logError",
        message: "Failed to load session history",
        error: input.error,
      });
    } else {
      state.session.historyStatus = input.history === null ? "unavailable" : "settled";
      if (input.history !== null && state.session.messages.length === 0) {
        state.session.messages = Array.from(input.history ?? []);
      }
    }
    state.sync.floor = null;
    state.recovery.historyPending = false;
    recovery.hydrateSnapshot(state, effects, floor.snapshot, true);
    for (const event of floor.events) recovery.applyEvent(state, effects, event);
    startReconcile(state, effects);
    return true;
  }

  const reconcile = state.sync.reconcile;
  if (!reconcile || reconcile.id !== input.id) return false;
  state.sync.reconcile = null;
  state.recovery.historyPending = false;
  if (input.error !== undefined) {
    effects.push({
      type: "logError",
      message: "Failed to reconcile session history",
      error: input.error,
    });
    return true;
  }
  if (
    reconcile.promptRevision !== state.prompt.revision ||
    state.outgoing.some(
      (message) => message.delivery === "follow-up" && message.status === "sending",
    )
  ) {
    return true;
  }
  if (input.history === null) {
    state.session.historyStatus = "unavailable";
    state.sync.needsReconcile = false;
    return true;
  }
  state.session.historyStatus = "settled";
  const canReplace =
    state.session.status !== "streaming" &&
    state.session.status !== "submitted" &&
    !hasFolds(state);
  if (canReplace) {
    state.session.messages = Array.from(input.history ?? []);
    state.sync.needsReconcile = false;
  }
  return true;
}
