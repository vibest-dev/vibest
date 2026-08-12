import type { SessionRuntimeSnapshot } from "@vibest/contract";
import type { UIMessage, UIMessageChunk } from "ai";

import type { ChatDraft, ChatEffects } from "./chat-runtime-types";
import { addUnique, removeValue, type ChatState } from "./chat-state";
import { sanitizeTail } from "./sanitize-tail";

export const hasFolds = (state: ChatState): boolean => Object.keys(state.turns.folds).length > 0;

export const hasClosingFolds = (state: ChatState): boolean =>
  Object.values(state.turns.folds).some((fold) => fold.status === "closing");

export function upsertAssistantMessage(state: ChatDraft, message: UIMessage): void {
  const snapshot = structuredClone(message);
  const metadata = snapshot.metadata as { runId?: unknown; segment?: unknown } | undefined;
  if (typeof metadata?.runId === "string" && typeof metadata.segment === "number") {
    const runId = metadata.runId;
    const segment = metadata.segment;
    const prefixLength = state.session.messages.reduce((total, candidate) => {
      const candidateMetadata = candidate.metadata as
        | { runId?: unknown; segment?: unknown }
        | undefined;
      return candidate.role === "assistant" &&
        candidateMetadata?.runId === runId &&
        typeof candidateMetadata?.segment === "number" &&
        candidateMetadata.segment < segment
        ? total + candidate.parts.length
        : total;
    }, 0);
    if (segment > 0 && prefixLength > 0) {
      snapshot.parts = snapshot.parts.slice(prefixLength);
    }
  }
  const index = state.session.messages.findIndex((candidate) => candidate.id === snapshot.id);
  if (index === -1) state.session.messages.push(snapshot);
  else state.session.messages[index] = snapshot;
}

export function abandonFold(state: ChatDraft, effects: ChatEffects, turnId: string): void {
  const fold = state.turns.folds[turnId];
  if (!fold) return;
  delete state.turns.folds[turnId];
  effects.push({ type: "closeFold", turnId, generation: fold.generation });
}

export function finishFold(state: ChatDraft, effects: ChatEffects, turnId: string): void {
  const fold = state.turns.folds[turnId];
  if (!fold || fold.status === "closing") return;
  state.turns.folds[turnId] = { ...fold, status: "closing" };
  effects.push({ type: "closeFold", turnId, generation: fold.generation });
}

export function appendFold(
  state: ChatDraft,
  effects: ChatEffects,
  turnId: string,
  chunk: UIMessageChunk,
): void {
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

export function captureChunkError(state: ChatDraft, chunk: UIMessageChunk): void {
  if (chunk.type === "error") state.session.error = new Error(chunk.errorText);
}

export function replayActiveTurn(
  state: ChatDraft,
  effects: ChatEffects,
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
    const recovered = removeValue(state.turns.recoverTurnIds, activeTurn.turnId);
    const errored = removeValue(state.turns.erroredTurnIds, activeTurn.turnId);
    if (recovered || errored) state.sync.needsReconcile = true;
  }
}
