import type {
  AgentRequest,
  PromptPart,
  SessionMessageChunkEvent,
  SessionPhase,
  SessionRef,
  SessionRuntimeSnapshot,
  SessionScopedEvent,
  SessionScopedEventBody,
  SessionStatus,
} from "@vibest/contract";

import { isSessionEvent, type SessionEnvelopeBody, type SessionEvent } from "./events/framework";

/**
 * The server-side truth a session's native event stream sheds, as a pure fold.
 * Harness agents stream native-`sessionId`-keyed drafts; this module turns a
 * draft into the wire {@link SessionScopedEvent} body and folds that event into
 * {@link SessionState} — the phase machine, the active-turn buffer, the pending
 * requests, and the cursor that snapshot/status read.
 *
 * Everything here is synchronous and total: no Effect, no clock, no I/O. The
 * stamping, publishing and locking that surround it belong to the caller.
 */

/** The AI-SDK UI chunk type, sourced from the contract to avoid an `ai` dependency. */
type WireChunk = SessionMessageChunkEvent["chunk"];

// Safety valve, not memory management: normal turns must never hit these.
// The buffer holds only the one in-flight turn and is dropped when the next
// turn starts, so the sole unbounded case is a runaway turn that never ends
// (an agent loop left running). Overflow drops the oldest chunks and marks
// the buffer truncated — consumers then skip it and recover the turn from
// the history read once it ends.
const MAX_BUFFERED_CHUNKS = 65536;
const MAX_BUFFERED_BYTES = 10 * 1024 * 1024;
// Eviction drops down to 3/4 of each cap at once so a saturated buffer
// amortizes to O(1) per chunk instead of shifting on every append.
const EVICT_TO_CHUNKS = Math.floor(MAX_BUFFERED_CHUNKS * 0.75);
const EVICT_TO_BYTES = Math.floor(MAX_BUFFERED_BYTES * 0.75);

/** Cheap size estimate: the delta/text payload for streaming chunks, a
 * serialization for the (rare, potentially large) structured ones. */
const chunkBytes = (chunk: WireChunk): number => {
  const delta = (chunk as { delta?: unknown }).delta;
  if (typeof delta === "string") return delta.length + 32;
  const text = (chunk as { text?: unknown }).text;
  if (typeof text === "string") return text.length + 32;
  try {
    return JSON.stringify(chunk).length;
  } catch {
    return 1024;
  }
};

type ActiveTurn = {
  readonly turnId: string;
  readonly messageId: string | null;
  // Mutable on purpose: the fold appends in place under the caller's apply
  // lock (previous SessionState values alias the same array — nothing retains
  // them), so a long turn is O(n) total instead of O(n²) copying. `toSnapshot`
  // hands out defensive copies.
  readonly chunks: SessionMessageChunkEvent[];
  readonly bytes: number;
  readonly complete: boolean;
  readonly truncated: boolean;
};

type ActivePrompt = {
  readonly messageId: string;
  readonly parts: ReadonlyArray<PromptPart>;
  readonly seq: number;
};

export type SessionState = {
  readonly seq: number;
  readonly cursor: number;
  readonly phase: SessionPhase;
  readonly activeTurn: ActiveTurn | null;
  readonly activePrompt: ActivePrompt | null;
  readonly pendingRequests: ReadonlyMap<string, AgentRequest>;
};

export const initialSessionState: SessionState = {
  seq: 0,
  cursor: 0,
  phase: "idle",
  activeTurn: null,
  activePrompt: null,
  pendingRequests: new Map(),
};

/** Native control body → wire body (drops the native `sessionId`); chunk → `session.message.chunk`. */
export const toWireBody = (
  body: SessionEnvelopeBody,
  activeTurnId: string | undefined,
): SessionScopedEventBody | null => {
  if (!isSessionEvent(body)) {
    // A UI chunk with no active turn is unexpected; drop rather than mislabel it.
    if (activeTurnId === undefined) return null;
    return { type: "session.message.chunk", turnId: activeTurnId, chunk: body as WireChunk };
  }
  const event = body as SessionEvent;
  switch (event.type) {
    case "session.turn.started":
      return { type: "session.turn.started", turnId: event.turnId };
    case "session.turn.ended":
      return {
        type: "session.turn.ended",
        turnId: event.turnId,
        outcome: event.outcome,
        ...(event.usage !== undefined ? { usage: event.usage } : {}),
        ...(event.error !== undefined ? { error: event.error } : {}),
      };
    case "session.request.asked":
      return { type: "session.request.asked", request: event.request };
    case "session.request.replied":
      return { type: "session.request.replied", requestId: event.requestId };
    case "session.request.rejected":
      return {
        type: "session.request.rejected",
        requestId: event.requestId,
        ...(event.reason !== undefined ? { reason: event.reason } : {}),
      };
    case "session.crashed":
      return { type: "session.crashed", reason: event.reason };
  }
};

const startChunkMessageId = (chunk: WireChunk): string | null =>
  chunk.type === "start" && typeof (chunk as { messageId?: unknown }).messageId === "string"
    ? (chunk as { messageId: string }).messageId
    : null;

// In-place append under the caps (see the ActiveTurn comment); overflow evicts
// from the front and marks the turn truncated — the newest chunks are what a
// reconnecting consumer is missing.
const appendChunk = (turn: ActiveTurn, event: SessionMessageChunkEvent): ActiveTurn => {
  const chunks = turn.chunks;
  chunks.push(event);
  let bytes = turn.bytes + chunkBytes(event.chunk);
  let truncated = turn.truncated;
  if (chunks.length > MAX_BUFFERED_CHUNKS || bytes > MAX_BUFFERED_BYTES) {
    let drop = 0;
    while (
      chunks.length - drop > 1 &&
      (chunks.length - drop > EVICT_TO_CHUNKS || bytes > EVICT_TO_BYTES)
    ) {
      const evicted = chunks[drop];
      if (evicted === undefined) break;
      bytes -= chunkBytes(evicted.chunk);
      drop += 1;
    }
    if (drop > 0) {
      chunks.splice(0, drop);
      truncated = true;
    }
  }
  return {
    ...turn,
    messageId: turn.messageId ?? startChunkMessageId(event.chunk),
    chunks,
    bytes,
    truncated,
  };
};

export const foldSessionEvent = (
  current: SessionState,
  event: SessionScopedEvent,
): SessionState => {
  const base = { ...current, seq: event.seq, cursor: event.seq };
  switch (event.type) {
    case "session.prompt.submitted":
      // The turn machine reacts only to the harness's own turn events, but the
      // prompt is retained (like the finished turn's buffer): the submit event
      // is never re-sent, so a client attaching mid-turn recovers the user
      // message from the snapshot. The next accepted prompt replaces it.
      return {
        ...base,
        activePrompt: { messageId: event.messageId, parts: event.parts, seq: event.seq },
      };
    case "session.prompt.rejected":
      // Only the still-retained prompt is cleared — a newer accepted prompt
      // must not be dropped by a stale rejection.
      return current.activePrompt?.messageId === event.messageId
        ? { ...base, activePrompt: null }
        : base;
    case "session.turn.started":
      // Starting a turn releases the previous turn's retained buffer.
      return {
        ...base,
        phase: "running",
        activeTurn: {
          turnId: event.turnId,
          messageId: null,
          chunks: [],
          bytes: 0,
          complete: false,
          truncated: false,
        },
      };
    case "session.message.chunk": {
      if (
        !current.activeTurn ||
        current.activeTurn.complete ||
        current.activeTurn.turnId !== event.turnId
      ) {
        return base;
      }
      return { ...base, activeTurn: appendChunk(current.activeTurn, event) };
    }
    case "session.turn.ended":
      // Keep the finished turn's chunks (marked complete) until the next turn
      // starts: a consumer recovering from a mid-turn disconnect replays the
      // tail from the snapshot. Real history reads supersede.
      return {
        ...base,
        phase: "idle",
        activeTurn: current.activeTurn ? { ...current.activeTurn, complete: true } : null,
      };
    case "session.request.asked": {
      const pendingRequests = new Map(current.pendingRequests).set(event.request.id, event.request);
      return { ...base, phase: "requires_action", pendingRequests };
    }
    case "session.request.replied":
    case "session.request.rejected": {
      const pendingRequests = new Map(current.pendingRequests);
      pendingRequests.delete(event.requestId);
      const phase: SessionPhase =
        pendingRequests.size > 0 ? "requires_action" : current.activeTurn ? "running" : "idle";
      return { ...base, phase, pendingRequests };
    }
    case "session.crashed":
      return {
        ...base,
        phase: "crashed",
        activeTurn: null,
        activePrompt: null,
        pendingRequests: new Map(),
      };
  }
};

export const toStatus = (state: SessionState): SessionStatus => ({
  phase: state.phase,
  ...(state.activeTurn && !state.activeTurn.complete
    ? { activeTurnId: state.activeTurn.turnId }
    : {}),
});

export const toSnapshot = (ref: SessionRef, state: SessionState): SessionRuntimeSnapshot => ({
  ref,
  status: toStatus(state),
  pendingRequests: [...state.pendingRequests.values()],
  activeTurn: state.activeTurn
    ? {
        turnId: state.activeTurn.turnId,
        messageId: state.activeTurn.messageId,
        chunks: [...state.activeTurn.chunks],
        complete: state.activeTurn.complete,
        truncated: state.activeTurn.truncated,
      }
    : null,
  activePrompt: state.activePrompt,
  cursor: state.cursor,
});
