import { handleHistoryCompleted, startReconcile } from "./chat-history";
import { maybeDispatchPrompt } from "./chat-outgoing";
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

// Pure at the module interface: copy the current state once, let the focused
// update helpers mutate only that private draft, and return state + effects.
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
    for (const outgoing of next.outgoing) {
      effects.push({
        type: "rejectPrompt",
        messageId: outgoing.message.id,
        error: new Error("Chat disposed"),
      });
    }
    next.outgoing = [];
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
  if (
    !isChatActive(state) &&
    input.type !== "transportEvent" &&
    input.type !== "requestResponseStarted"
  ) {
    return { state, effects: [] };
  }

  const next = copyChatState(state);
  const effects: ChatEffects = [];
  switch (input.type) {
    case "transportEvent":
      handleTransportEvent(next, effects, input.event);
      break;
    case "promptRequested":
      next.outgoing.push({ message: input.message, parts: input.parts, status: "queued" });
      maybeDispatchPrompt(next, effects);
      break;
    case "promptCompleted": {
      const index = next.outgoing.findIndex(
        (message) => message.message.id === input.messageId && message.status === "sending",
      );
      if (index === -1) return { state, effects: [] };
      next.outgoing.splice(index, 1);
      if (input.error) {
        next.prompt.deferredPhase = null;
        next.session.status = "error";
        next.session.error = input.error;
        effects.push({ type: "rejectPrompt", messageId: input.messageId, error: input.error });
      } else {
        effects.push({ type: "resolvePrompt", messageId: input.messageId });
        if (next.session.status !== "error") {
          const phase = next.prompt.deferredPhase;
          next.prompt.deferredPhase = null;
          if (phase !== null) next.session.status = statusFromPhase(phase);
        }
      }
      startReconcile(next, effects);
      maybeDispatchPrompt(next, effects);
      break;
    }
    case "historyCompleted":
      if (!handleHistoryCompleted(next, effects, input, historyRecovery)) {
        return { state, effects: [] };
      }
      break;
    case "foldUpdated": {
      const fold = next.turns.folds[input.turnId];
      if (!fold || fold.generation !== input.generation) return { state, effects: [] };
      upsertAssistantMessage(next, input.message);
      break;
    }
    case "foldFinished": {
      const fold = next.turns.folds[input.turnId];
      if (!fold || fold.generation !== input.generation) return { state, effects: [] };
      delete next.turns.folds[input.turnId];
      if (input.error !== undefined) {
        effects.push({ type: "logError", message: "Failed to fold turn", error: input.error });
      }
      startReconcile(next, effects);
      maybeDispatchPrompt(next, effects);
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
