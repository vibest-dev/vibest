import type {
  ActivePromptSnapshot,
  SessionMessageChunkEvent,
  SessionRuntimeSnapshot,
  SessionScopedEvent,
} from "@vibest/contract";

import type { AgentRequest, AgentResponse } from "./agent-requests";
import { startHistoryFloor, startReconcile } from "./chat-history";
import {
  acceptOutgoing,
  maybeDispatchOutgoing,
  pushUserMessage,
  rejectOutgoing,
  removeUserMessage,
  sendingMessage,
} from "./chat-outgoing";
import type { ChatDraft, ChatEffects } from "./chat-runtime-types";
import { addUnique, includesValue, isChatActive, removeValue, statusFromPhase } from "./chat-state";
import type { ChatTransportEvent } from "./chat-transport-port";
import {
  abandonFold,
  appendFold,
  captureChunkError,
  finishFold,
  replayActiveTurn,
} from "./chat-turn";

export function addRequest(state: ChatDraft, effects: ChatEffects, request: AgentRequest): void {
  if (request.type === "plan" && !request.plan.trim()) {
    const operationId = `auto-${state.nextOperationId}`;
    state.nextOperationId += 1;
    const response: AgentResponse = { type: "plan", behavior: "allow" };
    state.pendingResponses[operationId] = { request, restoreOnFailure: true, response };
    effects.push({ type: "respondToRequest", operationId, requestId: request.id, response });
    return;
  }
  const index = state.session.pendingRequests.findIndex((candidate) => candidate.id === request.id);
  if (index === -1) state.session.pendingRequests.push(request);
  else state.session.pendingRequests[index] = request;
}

export function hydrateSnapshot(
  state: ChatDraft,
  effects: ChatEffects,
  snapshot: SessionRuntimeSnapshot,
  skipGapCheck: boolean,
): void {
  if (!isChatActive(state)) return;
  if (snapshot.cursor < state.sync.cursor) {
    state.sync.cursor = 0;
    state.sync.needsReconcile = true;
  }

  state.session.pendingRequests = [];
  for (const request of snapshot.pendingRequests) addRequest(state, effects, request);

  const activeTurn = snapshot.activeTurn;
  for (const turnId of Object.keys(state.turns.folds)) {
    if (activeTurn?.turnId !== turnId) {
      abandonFold(state, effects, turnId);
      state.sync.needsReconcile = true;
    }
  }
  const stale = state.sync.cursor === 0 && activeTurn?.complete === true;
  const activePrompt = snapshot.activePrompt;
  const acceptedCorrelations: ActivePromptSnapshot[] = [
    ...snapshot.acceptedPrompts,
    ...(snapshot.acceptedPrompt ? [snapshot.acceptedPrompt] : []),
    ...(activePrompt && activePrompt.acceptedTurnId !== null ? [activePrompt] : []),
  ].filter(
    (prompt, index, prompts) =>
      prompts.findIndex((candidate) => candidate.messageId === prompt.messageId) === index,
  );
  const acceptedPrompts = acceptedCorrelations.filter(
    (prompt) => !(stale && prompt.acceptedTurnId === activeTurn?.turnId),
  );
  let acceptedFollowUp = false;
  for (const prompt of acceptedPrompts) {
    if (acceptOutgoing(state, effects, prompt.messageId)?.delivery === "follow-up") {
      acceptedFollowUp = true;
    }
  }
  const promptCandidates = [...acceptedPrompts, ...snapshot.pendingPrompts].filter(
    (prompt, index, prompts) =>
      prompts.findIndex((candidate) => candidate.messageId === prompt.messageId) === index,
  );
  const retainedPrompts: typeof promptCandidates = [];
  for (const prompt of promptCandidates) {
    const index = retainedPrompts.findIndex((candidate) => candidate.seq > prompt.seq);
    retainedPrompts.splice(index === -1 ? retainedPrompts.length : index, 0, prompt);
  }
  let appliedPromptSeq: number | undefined;
  for (const prompt of retainedPrompts) {
    if (prompt.seq <= state.sync.cursor) continue;
    appliedPromptSeq = Math.max(appliedPromptSeq ?? 0, prompt.seq);
    pushUserMessage(state, prompt.messageId, prompt.parts);
  }

  let latestError: SessionMessageChunkEvent | undefined;
  for (const event of activeTurn?.chunks ?? []) {
    if (event.seq > state.sync.cursor && event.chunk.type === "error") latestError = event;
  }
  if (latestError && (appliedPromptSeq === undefined || latestError.seq > appliedPromptSeq)) {
    captureChunkError(state, latestError.chunk);
  }

  for (const turnId of state.turns.recoverTurnIds.slice()) {
    if (activeTurn?.turnId !== turnId) {
      removeValue(state.turns.recoverTurnIds, turnId);
      removeValue(state.turns.erroredTurnIds, turnId);
      state.sync.needsReconcile = true;
    }
  }

  if (!skipGapCheck && snapshot.cursor > state.sync.cursor) {
    const retainedFloor = Math.min(
      ...retainedPrompts.map((prompt) => prompt.seq),
      !stale && activeTurn ? (activeTurn.chunks[0]?.seq ?? Infinity) : Infinity,
    );
    if (retainedFloor > state.sync.cursor + 1) state.sync.needsReconcile = true;
  }

  if (activeTurn && !stale) replayActiveTurn(state, effects, activeTurn);
  state.sync.cursor = Math.max(state.sync.cursor, snapshot.cursor);

  state.session.activeTurnId = activeTurn && !activeTurn.complete ? activeTurn.turnId : null;
  const snapshotLastEndedTurnId = activeTurn?.complete ? activeTurn.turnId : null;
  const snapshotBoundaryOpen =
    snapshot.pendingPrompts.length === 0 &&
    (snapshot.status.phase === "crashed" ||
      (snapshot.status.phase === "idle" &&
        acceptedCorrelations.every(
          (prompt) =>
            prompt.acceptedTurnId !== null &&
            activeTurn?.complete === true &&
            activeTurn.turnId === prompt.acceptedTurnId,
        )));
  const submitting = sendingMessage(state);
  if (!submitting) {
    state.prompt.pendingMessageIds = snapshot.pendingPrompts.map((prompt) => prompt.messageId);
    state.prompt.lastEndedTurnId = snapshotLastEndedTurnId;
    state.prompt.boundaryOpen = snapshotBoundaryOpen;
    const phase = acceptedFollowUp ? state.prompt.deferredPhase : null;
    state.prompt.deferredPhase = null;
    state.session.status = statusFromPhase(phase ?? snapshot.status.phase);
  } else {
    const accountsForPendingPrompt = acceptedCorrelations.some(
      (prompt) => prompt.acceptedTurnId !== null && submitting.message.id === prompt.messageId,
    );
    if (accountsForPendingPrompt) {
      state.prompt.pendingMessageIds = [];
      state.prompt.lastEndedTurnId = snapshotLastEndedTurnId;
    }
    for (const prompt of snapshot.pendingPrompts) {
      addUnique(state.prompt.pendingMessageIds, prompt.messageId);
    }
    state.prompt.boundaryOpen = accountsForPendingPrompt && snapshotBoundaryOpen;
    state.prompt.deferredPhase =
      accountsForPendingPrompt && (snapshot.status.phase !== "idle" || snapshotBoundaryOpen)
        ? snapshot.status.phase
        : null;
  }
  startReconcile(state, effects);
  maybeDispatchOutgoing(state, effects);
}

export function applyEvent(
  state: ChatDraft,
  effects: ChatEffects,
  event: SessionScopedEvent,
): void {
  if (!isChatActive(state) || event.seq <= state.sync.cursor) return;
  state.sync.cursor = event.seq;

  switch (event.type) {
    case "session.prompt.submitted":
      addUnique(state.prompt.pendingMessageIds, event.messageId);
      state.prompt.boundaryOpen = false;
      break;
    case "session.prompt.accepted": {
      const outgoing = acceptOutgoing(state, effects, event.messageId);
      const wasPending = removeValue(state.prompt.pendingMessageIds, event.messageId);
      if (wasPending || outgoing?.delivery === "follow-up") {
        state.prompt.boundaryOpen =
          state.prompt.pendingMessageIds.length === 0 &&
          (event.phase === "crashed" ||
            (event.phase === "idle" && state.prompt.lastEndedTurnId === event.turnId));
      }
      break;
    }
    case "session.prompt.rejected": {
      const error = new Error(event.reason);
      const outgoing = rejectOutgoing(state, effects, event.messageId, error);
      const wasPending = removeValue(state.prompt.pendingMessageIds, event.messageId);
      if (wasPending || outgoing?.delivery === "follow-up") {
        state.prompt.boundaryOpen =
          state.prompt.pendingMessageIds.length === 0 &&
          (event.phase === "idle" || event.phase === "crashed");
      }
      break;
    }
    case "session.turn.started":
      state.session.activeTurnId = event.turnId;
      state.prompt.boundaryOpen = false;
      break;
    case "session.turn.ended":
      if (state.session.activeTurnId === event.turnId) state.session.activeTurnId = null;
      state.prompt.lastEndedTurnId = event.turnId;
      state.prompt.boundaryOpen =
        state.prompt.pendingMessageIds.length === 0 &&
        (event.phase === "idle" || event.phase === "crashed");
      break;
    case "session.crashed":
      state.session.activeTurnId = null;
      state.prompt.pendingMessageIds = [];
      state.prompt.lastEndedTurnId = null;
      state.prompt.boundaryOpen = true;
      break;
    default:
      if (event.phase === "running" || event.phase === "requires_action") {
        state.prompt.boundaryOpen = false;
      }
  }

  switch (event.type) {
    case "session.message.chunk":
      captureChunkError(state, event.chunk);
      if (!includesValue(state.turns.recoverTurnIds, event.turnId)) {
        if (event.chunk.type === "error") addUnique(state.turns.erroredTurnIds, event.turnId);
        appendFold(state, effects, event.turnId, event.chunk);
      }
      break;
    case "session.prompt.submitted":
      pushUserMessage(state, event.messageId, event.parts);
      break;
    case "session.prompt.accepted":
      break;
    case "session.prompt.rejected":
      removeUserMessage(state, event.messageId);
      break;
    case "session.turn.started":
      break;
    case "session.turn.ended": {
      finishFold(state, effects, event.turnId);
      state.session.pendingRequests = [];
      if (
        event.outcome !== "completed" ||
        includesValue(state.turns.recoverTurnIds, event.turnId) ||
        includesValue(state.turns.erroredTurnIds, event.turnId) ||
        state.sync.needsReconcile
      ) {
        state.sync.needsReconcile = true;
      }
      removeValue(state.turns.recoverTurnIds, event.turnId);
      removeValue(state.turns.erroredTurnIds, event.turnId);
      break;
    }
    case "session.request.asked":
      addRequest(state, effects, event.request);
      break;
    case "session.request.replied":
    case "session.request.rejected":
      state.session.pendingRequests = state.session.pendingRequests.filter(
        (request) => request.id !== event.requestId,
      );
      break;
    case "session.crashed":
      for (const turnId of Object.keys(state.turns.folds)) abandonFold(state, effects, turnId);
      state.session.pendingRequests = [];
      break;
  }

  if (
    event.phase !== undefined &&
    event.type !== "session.message.chunk" &&
    event.type !== "session.prompt.submitted" &&
    event.type !== "session.prompt.accepted" &&
    event.type !== "session.prompt.rejected"
  ) {
    state.prompt.deferredPhase = null;
    state.session.status = statusFromPhase(event.phase);
  }
  startReconcile(state, effects);
  maybeDispatchOutgoing(state, effects);
}

function terminate(
  state: ChatDraft,
  effects: ChatEffects,
  reason: "session_closed" | "session_deleted",
): void {
  if (!isChatActive(state)) return;
  for (const turnId of Object.keys(state.turns.folds)) abandonFold(state, effects, turnId);
  state.sync.floor = null;
  state.sync.reconcile = null;
  for (const outgoing of state.outgoing) {
    effects.push({
      type: "rejectPrompt",
      messageId: outgoing.message.id,
      error: new Error("Session is no longer available"),
    });
  }
  state.outgoing = [];
  state.lifecycle.session = "terminated";
  state.session.activeTurnId = null;
  state.session.pendingRequests = [];
  state.session.historyStatus = "settled";
  state.session.status = "error";
  state.session.error = new Error(
    reason === "session_deleted" ? "Session deleted" : "Session closed",
  );
  effects.push({ type: "unsubscribe" }, { type: "notifyTerminated" });
}

export function handleTransportEvent(
  state: ChatDraft,
  effects: ChatEffects,
  event: ChatTransportEvent,
): void {
  if (event.type === "closed") {
    terminate(state, effects, event.reason);
    return;
  }
  if (!isChatActive(state)) return;
  if (event.type === "attached") {
    if (state.sync.reconcile && state.sync.reconcile.promptRevision !== state.prompt.revision) {
      state.sync.reconcile = null;
    }
    if (!state.sync.historyLoaded) {
      startHistoryFloor(state, effects, event.snapshot);
    } else if (state.sync.floor) {
      state.sync.floor = { ...state.sync.floor, snapshot: event.snapshot };
    } else {
      hydrateSnapshot(state, effects, event.snapshot, false);
    }
    return;
  }
  if (state.sync.floor) {
    state.sync.floor = { ...state.sync.floor, events: [...state.sync.floor.events, event] };
    return;
  }
  applyEvent(state, effects, event);
}
