import type { PromptPart } from "@vibest/contract";
import type { UIMessage } from "ai";

import type { ChatDraft, ChatEffects } from "./chat-runtime-types";
import { addUnique, isChatActive, type ChatState, type OutgoingMessage } from "./chat-state";

export const sendingMessage = (state: ChatState): OutgoingMessage | undefined =>
  state.outgoing.find(
    (message) => message.delivery === "follow-up" && message.status === "sending",
  );

const sendingDelivery = (
  state: ChatState,
  delivery: OutgoingMessage["delivery"],
): OutgoingMessage | undefined =>
  state.outgoing.find((message) => message.delivery === delivery && message.status === "sending");

const toUserMessage = (messageId: string, parts: ReadonlyArray<PromptPart>): UIMessage => ({
  id: messageId,
  role: "user",
  parts: parts.map((part) =>
    part.type === "data-inspector" ? { type: "data-inspector", data: part.data } : part,
  ) as UIMessage["parts"],
});

export function pushUserMessage(
  state: ChatDraft,
  messageId: string,
  parts: ReadonlyArray<PromptPart>,
): boolean {
  if (state.session.messages.some((message) => message.id === messageId)) return false;
  state.session.messages.push(toUserMessage(messageId, parts));
  state.session.error = undefined;
  return true;
}

export function removeUserMessage(state: ChatDraft, messageId: string): void {
  state.session.messages = state.session.messages.filter((message) => message.id !== messageId);
}

export function acceptOutgoing(
  state: ChatDraft,
  effects: ChatEffects,
  messageId: string,
): OutgoingMessage | undefined {
  const index = state.outgoing.findIndex((message) => message.message.id === messageId);
  if (index === -1) return undefined;
  const [outgoing] = state.outgoing.splice(index, 1);
  effects.push({ type: "resolvePrompt", messageId });
  return outgoing;
}

export function rejectOutgoing(
  state: ChatDraft,
  effects: ChatEffects,
  messageId: string,
  error: Error,
): OutgoingMessage | undefined {
  const index = state.outgoing.findIndex((message) => message.message.id === messageId);
  if (index === -1) return undefined;
  const outgoing = state.outgoing[index]!;
  if (outgoing.delivery === "steer") {
    state.outgoing[index] = { ...outgoing, status: "failed", error };
  } else {
    state.outgoing.splice(index, 1);
    state.prompt.deferredPhase = null;
  }
  effects.push({ type: "rejectPrompt", messageId, error });
  return outgoing;
}

function maybeDispatchSteer(state: ChatDraft, effects: ChatEffects): void {
  if (!isChatActive(state) || sendingDelivery(state, "steer")) return;
  const index = state.outgoing.findIndex(
    (message) => message.delivery === "steer" && message.status === "queued",
  );
  if (index === -1) return;
  const next = state.outgoing[index]!;
  const expectedTurnId = next.expectedTurnId;
  if (!expectedTurnId || state.session.activeTurnId !== expectedTurnId) {
    const error = new Error("The turn selected for steering is no longer active");
    state.outgoing[index] = { ...next, status: "failed", error };
    effects.push({ type: "rejectPrompt", messageId: next.message.id, error });
    return;
  }
  state.outgoing[index] = { ...next, status: "sending" };
  effects.push({
    type: "submitSteer",
    expectedTurnId,
    messageId: next.message.id,
    parts: next.parts,
  });
}

function maybeDispatchFollowUp(state: ChatDraft, effects: ChatEffects): void {
  const nextIndex = state.outgoing.findIndex(
    (message) => message.delivery === "follow-up" && message.status === "queued",
  );
  if (
    !isChatActive(state) ||
    sendingDelivery(state, "follow-up") !== undefined ||
    !state.sync.historyLoaded ||
    state.sync.floor !== null ||
    !state.prompt.boundaryOpen ||
    nextIndex === -1
  ) {
    return;
  }
  const next = state.outgoing[nextIndex]!;
  const reconcile = state.sync.reconcile;
  if (reconcile) {
    state.sync.reconcile = null;
    effects.push({ type: "cancelHistory", id: reconcile.id });
  }
  state.outgoing[nextIndex] = { ...next, status: "sending" };
  if (!state.session.messages.some((message) => message.id === next.message.id)) {
    state.session.messages.push(next.message);
  }
  state.session.status = "submitted";
  state.session.error = undefined;
  addUnique(state.prompt.pendingMessageIds, next.message.id);
  state.prompt.boundaryOpen = false;
  state.prompt.revision += 1;
  effects.push({ type: "submitPrompt", messageId: next.message.id, parts: next.parts });
}

export function maybeDispatchOutgoing(state: ChatDraft, effects: ChatEffects): void {
  maybeDispatchSteer(state, effects);
  maybeDispatchFollowUp(state, effects);
}
