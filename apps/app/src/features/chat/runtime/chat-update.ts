import type {
  PromptPart,
  SessionMessageChunkEvent,
  SessionPhase,
  SessionRuntimeSnapshot,
  SessionScopedEvent,
} from "@vibest/contract";
import type { UIMessage, UIMessageChunk } from "ai";

import type { AgentRequest, AgentResponse } from "./agent-requests";
import type { ChatState, OutgoingMessage, PendingResponse } from "./chat-state";
import type { ChatTransportEvent } from "./chat-transport-port";
import { sanitizeTail } from "./sanitize-tail";

export type ChatInput =
  | { readonly type: "transportEvent"; readonly event: ChatTransportEvent }
  | {
      readonly type: "promptRequested";
      readonly message: UIMessage;
      readonly parts: ReadonlyArray<PromptPart>;
    }
  | {
      readonly type: "promptCompleted";
      readonly messageId: string;
      readonly error?: Error;
    }
  | {
      readonly type: "historyCompleted";
      readonly id: number;
      readonly purpose: "floor" | "reconcile";
      readonly history?: ReadonlyArray<UIMessage> | null;
      readonly error?: unknown;
    }
  | {
      readonly type: "foldUpdated";
      readonly turnId: string;
      readonly generation: number;
      readonly message: UIMessage;
    }
  | {
      readonly type: "foldFinished";
      readonly turnId: string;
      readonly generation: number;
      readonly error?: unknown;
    }
  | {
      readonly type: "requestResponseStarted";
      readonly operationId: string;
      readonly requestId: string;
      readonly response: AgentResponse;
    }
  | {
      readonly type: "requestResponseCompleted";
      readonly operationId: string;
      readonly error?: unknown;
    }
  | { readonly type: "dispose" };

export type ChatEffect =
  | { readonly type: "readHistory"; readonly id: number; readonly purpose: "floor" | "reconcile" }
  | {
      readonly type: "submitPrompt";
      readonly messageId: string;
      readonly parts: ReadonlyArray<PromptPart>;
    }
  | {
      readonly type: "respondToRequest";
      readonly operationId: string;
      readonly requestId: string;
      readonly response: AgentResponse;
    }
  | { readonly type: "openFold"; readonly turnId: string; readonly generation: number }
  | {
      readonly type: "appendFold";
      readonly turnId: string;
      readonly generation: number;
      readonly chunk: UIMessageChunk;
    }
  | { readonly type: "closeFold"; readonly turnId: string; readonly generation: number }
  | { readonly type: "resolvePrompt"; readonly messageId: string }
  | { readonly type: "rejectPrompt"; readonly messageId: string; readonly error: Error }
  | { readonly type: "settleResponse"; readonly operationId: string }
  | { readonly type: "unsubscribe" }
  | { readonly type: "notifyTerminated" }
  | { readonly type: "logError"; readonly message: string; readonly error: unknown };

export type ChatTransition = {
  readonly state: ChatState;
  readonly effects: ReadonlyArray<ChatEffect>;
};

type Draft = ChatState;
type Effects = ChatEffect[];

function copyState(state: ChatState): Draft {
  return {
    ...state,
    session: {
      ...state.session,
      messages: state.session.messages.slice(),
      pendingRequests: state.session.pendingRequests.slice(),
    },
    outgoing: state.outgoing.slice(),
    lifecycle: { ...state.lifecycle },
    sync: {
      ...state.sync,
      floor: state.sync.floor
        ? { ...state.sync.floor, events: state.sync.floor.events.slice() }
        : null,
      reconcile: state.sync.reconcile ? { ...state.sync.reconcile } : null,
    },
    prompt: {
      ...state.prompt,
      pendingMessageIds: state.prompt.pendingMessageIds.slice(),
    },
    turns: {
      ...state.turns,
      folds: { ...state.turns.folds },
      recoverTurnIds: state.turns.recoverTurnIds.slice(),
      erroredTurnIds: state.turns.erroredTurnIds.slice(),
    },
    pendingResponses: { ...state.pendingResponses },
  };
}

const isActive = (state: ChatState): boolean =>
  state.lifecycle.session === "available" && state.lifecycle.instance === "active";

const statusFromPhase = (phase: SessionPhase): "streaming" | "ready" | "error" => {
  switch (phase) {
    case "idle":
      return "ready";
    case "crashed":
      return "error";
    default:
      return "streaming";
  }
};

const includes = (values: ReadonlyArray<string>, value: string): boolean => values.includes(value);

function addUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value);
}

function remove(values: string[], value: string): boolean {
  const index = values.indexOf(value);
  if (index === -1) return false;
  values.splice(index, 1);
  return true;
}

const sendingMessage = (state: ChatState): OutgoingMessage | undefined =>
  state.outgoing.find((message) => message.status === "sending");

const hasFolds = (state: ChatState): boolean => Object.keys(state.turns.folds).length > 0;

const hasClosingFolds = (state: ChatState): boolean =>
  Object.values(state.turns.folds).some((fold) => fold.status === "closing");

const toUserMessage = (messageId: string, parts: ReadonlyArray<PromptPart>): UIMessage => ({
  id: messageId,
  role: "user",
  parts: parts.map((part) =>
    part.type === "data-inspector" ? { type: "data-inspector", data: part.data } : part,
  ) as UIMessage["parts"],
});

function pushUserMessage(
  state: Draft,
  messageId: string,
  parts: ReadonlyArray<PromptPart>,
): boolean {
  if (state.session.messages.some((message) => message.id === messageId)) return false;
  state.session.messages.push(toUserMessage(messageId, parts));
  state.session.error = undefined;
  return true;
}

function removeUserMessage(state: Draft, messageId: string): void {
  state.session.messages = state.session.messages.filter((message) => message.id !== messageId);
}

function upsertAssistantMessage(state: Draft, message: UIMessage): void {
  const snapshot = structuredClone(message);
  const index = state.session.messages.findIndex((candidate) => candidate.id === snapshot.id);
  if (index === -1) state.session.messages.push(snapshot);
  else state.session.messages[index] = snapshot;
}

function addRequest(state: Draft, effects: Effects, request: AgentRequest): void {
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

function abandonFold(state: Draft, effects: Effects, turnId: string): void {
  const fold = state.turns.folds[turnId];
  if (!fold) return;
  delete state.turns.folds[turnId];
  effects.push({ type: "closeFold", turnId, generation: fold.generation });
}

function finishFold(state: Draft, effects: Effects, turnId: string): void {
  const fold = state.turns.folds[turnId];
  if (!fold || fold.status === "closing") return;
  state.turns.folds[turnId] = { ...fold, status: "closing" };
  effects.push({ type: "closeFold", turnId, generation: fold.generation });
}

function appendFold(state: Draft, effects: Effects, turnId: string, chunk: UIMessageChunk): void {
  let fold = state.turns.folds[turnId];
  if (!fold) {
    fold = { generation: state.turns.nextGeneration, status: "open" };
    state.turns.nextGeneration += 1;
    state.turns.folds[turnId] = fold;
    effects.push({ type: "openFold", turnId, generation: fold.generation });
  }
  if (fold.status === "open") {
    effects.push({ type: "appendFold", turnId, generation: fold.generation, chunk });
  }
}

function captureChunkError(state: Draft, chunk: UIMessageChunk): void {
  if (chunk.type === "error") state.session.error = new Error(chunk.errorText);
}

function startHistoryFloor(state: Draft, effects: Effects, snapshot: SessionRuntimeSnapshot): void {
  const id = state.nextOperationId;
  state.nextOperationId += 1;
  state.sync.historyLoaded = true;
  state.sync.floor = { id, snapshot, events: [] };
  effects.push({ type: "readHistory", id, purpose: "floor" });
}

function startReconcile(state: Draft, effects: Effects): void {
  if (
    !isActive(state) ||
    !state.sync.needsReconcile ||
    state.sync.floor !== null ||
    state.sync.reconcile !== null ||
    sendingMessage(state) !== undefined ||
    hasClosingFolds(state)
  ) {
    return;
  }
  const id = state.nextOperationId;
  state.nextOperationId += 1;
  state.sync.reconcile = { id, promptRevision: state.prompt.revision };
  effects.push({ type: "readHistory", id, purpose: "reconcile" });
}

function maybeDispatchPrompt(state: Draft, effects: Effects): void {
  const nextIndex = state.outgoing.findIndex((message) => message.status === "queued");
  if (
    !isActive(state) ||
    sendingMessage(state) !== undefined ||
    !state.sync.historyLoaded ||
    state.sync.floor !== null ||
    !state.prompt.boundaryOpen ||
    nextIndex === -1
  ) {
    return;
  }
  const next = state.outgoing[nextIndex]!;
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

function replayActiveTurn(
  state: Draft,
  effects: Effects,
  activeTurn: NonNullable<SessionRuntimeSnapshot["activeTurn"]>,
): void {
  const unseen = activeTurn.chunks.filter((event) => event.seq > state.sync.cursor);
  const head = activeTurn.chunks[0];
  const contiguous = head !== undefined && head.seq <= state.sync.cursor + 1;
  let chunks: UIMessageChunk[];
  if (!activeTurn.truncated || contiguous) {
    chunks = unseen.map((event) => event.chunk);
  } else if (state.sync.cursor === 0) {
    chunks = sanitizeTail(unseen.map((event) => event.chunk));
    addUnique(state.turns.recoverTurnIds, activeTurn.turnId);
  } else if (activeTurn.complete) {
    state.sync.needsReconcile = true;
    return;
  } else {
    addUnique(state.turns.recoverTurnIds, activeTurn.turnId);
    return;
  }
  for (const chunk of chunks) {
    if (chunk.type === "error") addUnique(state.turns.erroredTurnIds, activeTurn.turnId);
    appendFold(state, effects, activeTurn.turnId, chunk);
  }
  if (activeTurn.complete) {
    finishFold(state, effects, activeTurn.turnId);
    const recovered = remove(state.turns.recoverTurnIds, activeTurn.turnId);
    const errored = remove(state.turns.erroredTurnIds, activeTurn.turnId);
    if (recovered || errored) state.sync.needsReconcile = true;
  }
}

function hydrateSnapshot(
  state: Draft,
  effects: Effects,
  snapshot: SessionRuntimeSnapshot,
  skipGapCheck: boolean,
): void {
  if (!isActive(state)) return;
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
  const acceptedPrompt =
    snapshot.acceptedPrompt ?? (activePrompt?.acceptedTurnId !== null ? activePrompt : null);
  const acceptedPromptBelongsToStaleTurn =
    stale && acceptedPrompt?.acceptedTurnId === activeTurn?.turnId;
  const promptCandidates = [
    ...(acceptedPrompt && !acceptedPromptBelongsToStaleTurn ? [acceptedPrompt] : []),
    ...snapshot.pendingPrompts,
  ].filter(
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
      remove(state.turns.recoverTurnIds, turnId);
      remove(state.turns.erroredTurnIds, turnId);
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

  const snapshotLastEndedTurnId = activeTurn?.complete ? activeTurn.turnId : null;
  const snapshotBoundaryOpen =
    snapshot.pendingPrompts.length === 0 &&
    (snapshot.status.phase === "crashed" ||
      (snapshot.status.phase === "idle" &&
        (acceptedPrompt === null ||
          (acceptedPrompt.acceptedTurnId !== null &&
            activeTurn?.complete === true &&
            activeTurn.turnId === acceptedPrompt.acceptedTurnId))));
  const submitting = sendingMessage(state);
  if (!submitting) {
    state.prompt.pendingMessageIds = snapshot.pendingPrompts.map((prompt) => prompt.messageId);
    state.prompt.lastEndedTurnId = snapshotLastEndedTurnId;
    state.prompt.boundaryOpen = snapshotBoundaryOpen;
    state.prompt.deferredPhase = null;
    state.session.status = statusFromPhase(snapshot.status.phase);
  } else {
    const accountsForPendingPrompt =
      acceptedPrompt !== null &&
      acceptedPrompt.acceptedTurnId !== null &&
      submitting.message.id === acceptedPrompt.messageId;
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
  maybeDispatchPrompt(state, effects);
}

function applyEvent(state: Draft, effects: Effects, event: SessionScopedEvent): void {
  if (!isActive(state) || event.seq <= state.sync.cursor) return;
  state.sync.cursor = event.seq;

  switch (event.type) {
    case "session.prompt.submitted":
      addUnique(state.prompt.pendingMessageIds, event.messageId);
      state.prompt.boundaryOpen = false;
      break;
    case "session.prompt.accepted":
      if (remove(state.prompt.pendingMessageIds, event.messageId)) {
        state.prompt.boundaryOpen =
          state.prompt.pendingMessageIds.length === 0 &&
          (event.phase === "crashed" ||
            (event.phase === "idle" && state.prompt.lastEndedTurnId === event.turnId));
      }
      break;
    case "session.prompt.rejected":
      if (remove(state.prompt.pendingMessageIds, event.messageId)) {
        state.prompt.boundaryOpen =
          state.prompt.pendingMessageIds.length === 0 &&
          (event.phase === "idle" || event.phase === "crashed");
      }
      break;
    case "session.turn.started":
      state.prompt.boundaryOpen = false;
      break;
    case "session.turn.ended":
      state.prompt.lastEndedTurnId = event.turnId;
      state.prompt.boundaryOpen =
        state.prompt.pendingMessageIds.length === 0 &&
        (event.phase === "idle" || event.phase === "crashed");
      break;
    case "session.crashed":
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
      if (!includes(state.turns.recoverTurnIds, event.turnId)) {
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
        includes(state.turns.recoverTurnIds, event.turnId) ||
        includes(state.turns.erroredTurnIds, event.turnId) ||
        state.sync.needsReconcile
      ) {
        state.sync.needsReconcile = true;
      }
      remove(state.turns.recoverTurnIds, event.turnId);
      remove(state.turns.erroredTurnIds, event.turnId);
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
  maybeDispatchPrompt(state, effects);
}

function terminate(
  state: Draft,
  effects: Effects,
  reason: "session_closed" | "session_deleted",
): void {
  if (!isActive(state)) return;
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
  state.session.pendingRequests = [];
  state.session.historyStatus = "settled";
  state.session.status = "error";
  state.session.error = new Error(
    reason === "session_deleted" ? "Session deleted" : "Session closed",
  );
  effects.push({ type: "unsubscribe" }, { type: "notifyTerminated" });
}

function handleTransportEvent(state: Draft, effects: Effects, event: ChatTransportEvent): void {
  if (event.type === "closed") {
    terminate(state, effects, event.reason);
    return;
  }
  if (!isActive(state)) return;
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

function handleHistoryCompleted(
  state: Draft,
  effects: Effects,
  input: Extract<ChatInput, { type: "historyCompleted" }>,
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
    hydrateSnapshot(state, effects, floor.snapshot, true);
    for (const event of floor.events) applyEvent(state, effects, event);
    startReconcile(state, effects);
    maybeDispatchPrompt(state, effects);
    return true;
  }

  const reconcile = state.sync.reconcile;
  if (!reconcile || reconcile.id !== input.id) return false;
  state.sync.reconcile = null;
  if (input.error !== undefined) {
    effects.push({
      type: "logError",
      message: "Failed to reconcile session history",
      error: input.error,
    });
    return true;
  }
  if (reconcile.promptRevision !== state.prompt.revision || sendingMessage(state)) return true;
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

export function updateChat(state: ChatState, input: ChatInput): ChatTransition {
  if (input.type === "requestResponseCompleted") {
    const pending = state.pendingResponses[input.operationId];
    if (!pending) return { state, effects: [] };
    const next = copyState(state);
    delete next.pendingResponses[input.operationId];
    const effects: Effects = [{ type: "settleResponse", operationId: input.operationId }];
    if (
      input.error !== undefined &&
      pending.restoreOnFailure &&
      pending.request &&
      isActive(next)
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
    const next = copyState(state);
    const effects: Effects = [];
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

  if (input.type === "promptRequested" && !isActive(state)) {
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
    !isActive(state) &&
    input.type !== "transportEvent" &&
    input.type !== "requestResponseStarted"
  ) {
    return { state, effects: [] };
  }

  const next = copyState(state);
  const effects: Effects = [];
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
      if (!handleHistoryCompleted(next, effects, input)) return { state, effects: [] };
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
