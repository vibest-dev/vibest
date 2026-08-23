import { handleHistoryCompleted, startReconcile } from "./chat-history";
import { acceptOutgoing, maybeDispatchOutgoing, rejectOutgoing } from "./chat-outgoing";
import type { ChatEffects, ChatInput, ChatTransition } from "./chat-runtime-types";
import { addRequest, applyEvent, handleTransportEvent, hydrateSnapshot } from "./chat-session";
import {
  copyChatState,
  isChatActive,
  statusFromPhase,
  type ChatState,
  type PendingResponse,
} from "./chat-state";
import { abandonFold, upsertAssistantMessage } from "./chat-turn";

export type { ChatEffect, ChatInput, ChatTransition } from "./chat-runtime-types";

const historyRecovery = { hydrateSnapshot, applyEvent };

// Pure at the module interface: reject known no-ops before allocating, copy only
// the branches touched by hot updates, and use a private full draft for complex paths.
export function updateChat(state: ChatState, input: ChatInput): ChatTransition {
  if (input.type === "requestResponseCompleted") {
    const pending = state.pendingResponses[input.operationId];
    if (!pending) return { state, effects: [] };
    const next = copyChatState(state);
    delete next.pendingResponses[input.operationId];
    const effects: ChatEffects = [{ type: "settleResponse", operationId: input.operationId }];
    if (
      input.error !== undefined &&
      pending.restoreOnFailure &&
      pending.request &&
      isChatActive(next)
    ) {
      addRequest(next, effects, pending.request);
      effects.push({
        type: "logError",
        message: "Failed to respond to agent request",
        error: input.error,
      });
    }
    return { state: next, effects };
  }

  if (input.type === "dispose") {
    if (state.lifecycle.instance === "disposed") return { state, effects: [] };
    const next = copyChatState(state);
    const effects: ChatEffects = [];
    next.lifecycle.instance = "disposed";
    effects.push({ type: "abortLifetime" });
    for (const outgoing of next.outgoing) {
      effects.push({
        type: "rejectPrompt",
        messageId: outgoing.message.id,
        error: new Error("Chat disposed"),
      });
    }
    next.outgoing = [];
    for (const operationId of Object.keys(next.pendingResponses)) {
      effects.push({ type: "settleResponse", operationId });
    }
    next.pendingResponses = {};
    for (const turnId of Object.keys(next.turns.folds)) abandonFold(next, effects, turnId);
    effects.push({ type: "unsubscribe" });
    return { state: next, effects };
  }

  if (input.type === "promptRequested" && !isChatActive(state)) {
    return {
      state,
      effects: [
        {
          type: "rejectPrompt",
          messageId: input.message.id,
          error: new Error(
            state.lifecycle.session === "terminated"
              ? "Session is no longer available"
              : "Chat disposed",
          ),
        },
      ],
    };
  }
  if (input.type === "steerRequested" && !isChatActive(state)) {
    return { state, effects: [] };
  }
  if (
    !isChatActive(state) &&
    input.type !== "transportEvent" &&
    input.type !== "requestResponseStarted"
  ) {
    return { state, effects: [] };
  }

  if (
    input.type === "transportEvent" &&
    input.event.type !== "attached" &&
    input.event.type !== "closed" &&
    input.event.seq <= state.sync.cursor
  ) {
    return { state, effects: [] };
  }
  if (
    input.type === "historyCompleted" &&
    (input.purpose === "floor" ? state.sync.floor : state.sync.reconcile)?.id !== input.id
  ) {
    return { state, effects: [] };
  }
  if (
    input.type === "outgoingCompleted" &&
    !state.outgoing.some(
      (message) => message.message.id === input.messageId && message.status === "sending",
    )
  ) {
    return { state, effects: [] };
  }
  if (
    (input.type === "foldUpdated" || input.type === "foldFinished") &&
    state.turns.folds[input.turnId]?.generation !== input.generation
  ) {
    return { state, effects: [] };
  }

  if (input.type === "foldUpdated") {
    const next: ChatState = {
      ...state,
      session: {
        ...state.session,
        messages: state.session.messages.slice(),
      },
    };
    upsertAssistantMessage(next, input.message);
    return { state: next, effects: [] };
  }

  const next = copyChatState(state);
  const effects: ChatEffects = [];
  switch (input.type) {
    case "transportEvent":
      handleTransportEvent(next, effects, input.event);
      break;
    case "promptRequested":
      next.outgoing.push({
        message: input.message,
        parts: input.parts,
        delivery: "follow-up",
        status: "queued",
      });
      maybeDispatchOutgoing(next, effects);
      break;
    case "steerRequested": {
      const index = next.outgoing.findIndex(
        (message) =>
          message.message.id === input.messageId &&
          message.delivery === "follow-up" &&
          message.status === "queued",
      );
      if (index === -1 || !next.session.activeTurnId) return { state, effects: [] };
      next.outgoing[index] = {
        ...next.outgoing[index]!,
        delivery: "steer",
        expectedTurnId: next.session.activeTurnId,
        error: undefined,
      };
      maybeDispatchOutgoing(next, effects);
      break;
    }
    case "outgoingCompleted": {
      const index = next.outgoing.findIndex(
        (message) => message.message.id === input.messageId && message.status === "sending",
      );
      if (index === -1) return { state, effects: [] };
      if (input.error) {
        rejectOutgoing(next, effects, input.messageId, input.error);
        if (input.delivery === "follow-up") {
          next.session.status = "error";
          next.session.error = input.error;
        }
      } else {
        acceptOutgoing(next, effects, input.messageId);
        if (input.delivery === "follow-up" && next.session.status !== "error") {
          const phase = next.prompt.deferredPhase;
          next.prompt.deferredPhase = null;
          if (phase !== null) next.session.status = statusFromPhase(phase);
        }
      }
      startReconcile(next, effects);
      maybeDispatchOutgoing(next, effects);
      break;
    }
    case "historyCompleted":
      if (!handleHistoryCompleted(next, effects, input, historyRecovery)) {
        return { state, effects: [] };
      }
      break;
    case "foldFinished": {
      delete next.turns.folds[input.turnId];
      if (input.error !== undefined) {
        effects.push({ type: "logError", message: "Failed to fold turn", error: input.error });
      }
      startReconcile(next, effects);
      maybeDispatchOutgoing(next, effects);
      break;
    }
    case "requestResponseStarted": {
      const request = next.session.pendingRequests.find((item) => item.id === input.requestId);
      next.session.pendingRequests = next.session.pendingRequests.filter(
        (item) => item.id !== input.requestId,
      );
      next.pendingResponses[input.operationId] = {
        request,
        restoreOnFailure: true,
        response: input.response,
      } satisfies PendingResponse;
      effects.push({
        type: "respondToRequest",
        operationId: input.operationId,
        requestId: input.requestId,
        response: input.response,
      });
      break;
    }
  }
  return { state: next, effects };
}
