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
import { Data, Deferred, Effect, Fiber, Ref, Scope, Semaphore, Stream } from "effect";

import type { EventBusShape } from "../events/event-bus";
import type { AgentOperationError } from "./errors";
import { isSessionEvent, type SessionEnvelopeBody, type SessionEvent } from "./events/framework";

/** The AI-SDK UI chunk type, sourced from the contract to avoid an `ai` dependency. */
type WireChunk = SessionMessageChunkEvent["chunk"];

/**
 * The live projection over a session's native event stream. The harness agents
 * stream native-`sessionId`-keyed drafts; this owns the server-side truth they
 * shed: it stamps a per-session, contiguous `seq`, folds the projection (phase
 * machine, active-turn buffer, pending requests, cursor), translates drafts
 * into the wire {@link SessionScopedEvent} (attaching the {@link SessionRef}),
 * and publishes onto the EventBus. Snapshot/status read the projection. It is
 * an internal collaborator of {@link HarnessAgentSessionService} — no Context
 * tag — and never touches processes; instance lifecycle is
 * {@link HarnessAgentSessionManager}'s job.
 */

export class SessionNotActive extends Data.TaggedError("SessionNotActive")<{
  readonly sessionId: string;
}> {}

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
  // Mutable on purpose: `fold` appends in place under the runtime's applyLock
  // (previous Projection values alias the same array — nothing retains them),
  // so a long turn is O(n) total instead of O(n²) copying. `toSnapshot` hands
  // out defensive copies.
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

type Projection = {
  readonly seq: number;
  readonly cursor: number;
  readonly phase: SessionPhase;
  readonly activeTurn: ActiveTurn | null;
  readonly activePrompt: ActivePrompt | null;
  readonly pendingRequests: ReadonlyMap<string, AgentRequest>;
};

const initialProjection: Projection = {
  seq: 0,
  cursor: 0,
  phase: "idle",
  activeTurn: null,
  activePrompt: null,
  pendingRequests: new Map(),
};

/** Native control body → wire body (drops the native `sessionId`); chunk → `session.message.chunk`. */
const toWireBody = (
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

const fold = (current: Projection, event: SessionScopedEvent): Projection => {
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
      // tail from the snapshot. Real history reads (tickets 10/11) supersede.
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

const toSnapshot = (ref: SessionRef, projection: Projection): SessionRuntimeSnapshot => ({
  ref,
  status: toStatus(projection),
  pendingRequests: [...projection.pendingRequests.values()],
  activeTurn: projection.activeTurn
    ? {
        turnId: projection.activeTurn.turnId,
        messageId: projection.activeTurn.messageId,
        chunks: [...projection.activeTurn.chunks],
        complete: projection.activeTurn.complete,
        truncated: projection.activeTurn.truncated,
      }
    : null,
  activePrompt: projection.activePrompt,
  cursor: projection.cursor,
});

const toStatus = (projection: Projection): SessionStatus => ({
  phase: projection.phase,
  ...(projection.activeTurn && !projection.activeTurn.complete
    ? { activeTurnId: projection.activeTurn.turnId }
    : {}),
});

// One live in-memory session (ours): projection + seq + the fiber draining the
// HarnessAgent's native event stream, plus the wire-body applier so events
// originating outside the native stream (`emit`) share the same seq counter.
type SessionRuntime = {
  readonly ref: SessionRef;
  readonly projection: Ref.Ref<Projection>;
  readonly fiber: Fiber.Fiber<void>;
  readonly applyWire: (body: SessionScopedEventBody) => Effect.Effect<void>;
};

export type HarnessAgentSessionRuntimeShape = {
  /**
   * Begin draining a session's native draft stream: stamp, fold, and fan out.
   * Idempotent: a live runtime for the ref makes this a no-op, so concurrent
   * resumes can never split the single-consumer native stream across two drain
   * fibers. A crashed runtime is replaced. `onCrash` runs once if the native
   * stream fails (the façade closes the native session there).
   */
  readonly start: (
    ref: SessionRef,
    events: Stream.Stream<SessionEnvelopeBody, AgentOperationError>,
    options?: { readonly onCrash?: Effect.Effect<void> },
  ) => Effect.Effect<void>;
  readonly stop: (ref: SessionRef) => Effect.Effect<void>;
  readonly snapshot: (ref: SessionRef) => Effect.Effect<SessionRuntimeSnapshot, SessionNotActive>;
  readonly status: (ref: SessionRef) => Effect.Effect<SessionStatus, SessionNotActive>;
  /**
   * Inject a server-originated wire event into the session's stream: it gets
   * the same contiguous seq stamping and bus fan-out as harness-driven events.
   */
  readonly emit: (
    ref: SessionRef,
    body: SessionScopedEventBody,
  ) => Effect.Effect<void, SessionNotActive>;
};

export const makeHarnessAgentSessionRuntime = (
  bus: EventBusShape,
): Effect.Effect<HarnessAgentSessionRuntimeShape, never, Scope.Scope> =>
  Effect.gen(function* () {
    const ownerScope = yield* Scope.Scope;
    const runtimes = yield* Ref.make<ReadonlyMap<string, SessionRuntime>>(new Map());

    // Identity-guarded: only the runtime that owns the entry may delete it, so
    // a superseded drain fiber's cleanup can never evict its replacement.
    const removeOwned = (sessionId: string, projection: Ref.Ref<Projection>) =>
      Ref.update(runtimes, (current) => {
        const entry = current.get(sessionId);
        if (!entry || entry.projection !== projection) return current;
        const next = new Map(current);
        next.delete(sessionId);
        return next;
      });

    const getRuntime = (ref: SessionRef): Effect.Effect<SessionRuntime, SessionNotActive> =>
      Ref.get(runtimes).pipe(
        Effect.flatMap((current) => {
          const runtime = current.get(ref.sessionId);
          return runtime
            ? Effect.succeed(runtime)
            : Effect.fail(new SessionNotActive({ sessionId: ref.sessionId }));
        }),
      );

    const start: HarnessAgentSessionRuntimeShape["start"] = (ref, events, options) =>
      Effect.gen(function* () {
        // A live runtime keeps draining; only a crashed one is replaced (its
        // fiber is already dead — interrupt is a harmless formality).
        const existing = (yield* Ref.get(runtimes)).get(ref.sessionId);
        if (existing) {
          const phase = (yield* Ref.get(existing.projection)).phase;
          if (phase !== "crashed") return;
          yield* Fiber.interrupt(existing.fiber);
          yield* removeOwned(ref.sessionId, existing.projection);
        }

        const projection = yield* Ref.make(initialProjection);

        // Serializes stamp+publish across the drain fiber and `emit` callers:
        // without it two fibers could stamp seqs n/n+1 but publish n+1 first,
        // and the clients' `seq <= cursor` replay guard would drop n forever.
        const applyLock = Semaphore.makeUnsafe(1);

        // The body builder runs under the same permit as the fold+publish so
        // both read one consistent projection — deriving the active turn from
        // a read outside the lock would reintroduce exactly the interleaving
        // the lock exists to stop.
        const applyWith = (
          make: (current: Projection) => SessionScopedEventBody | null,
        ): Effect.Effect<void> =>
          applyLock.withPermit(
            Ref.get(projection).pipe(
              Effect.flatMap((current) => {
                const wireBody = make(current);
                if (!wireBody) return Effect.void;
                const event: SessionScopedEvent = { seq: current.seq + 1, ref, ...wireBody };
                const next = fold(current, event);
                // Publish with the post-fold phase stamped on: consumers copy
                // the session's phase off the event instead of re-deriving it
                // from event types. (The buffered chunk copy inside `next`
                // keeps the un-stamped draft — snapshot replays read phase
                // from the snapshot's own status.)
                return Ref.set(projection, next).pipe(
                  Effect.andThen(bus.publish({ ...event, phase: next.phase })),
                );
              }),
            ),
          );

        const applyWire = (wireBody: SessionScopedEventBody): Effect.Effect<void> =>
          applyWith(() => wireBody);

        const apply = (body: SessionEnvelopeBody) =>
          applyWith((current) =>
            toWireBody(
              body,
              current.activeTurn && !current.activeTurn.complete
                ? current.activeTurn.turnId
                : undefined,
            ),
          );

        const crash = (reason: string) =>
          apply({ type: "session.crashed", sessionId: ref.sessionId, reason });

        // The drain waits for its map entry before consuming, so an instantly
        // ending stream can never run cleanup ahead of registration. A natural
        // end drops the runtime; a crash keeps the projection queryable (phase
        // "crashed") until close/delete/resume, after `onCrash` released the
        // native session.
        const registered = yield* Deferred.make<void>();
        const drain = Deferred.await(registered).pipe(
          Effect.andThen(Stream.runForEach(events, apply)),
          Effect.andThen(removeOwned(ref.sessionId, projection)),
          Effect.catch((error) =>
            crash(error.message).pipe(Effect.andThen(options?.onCrash ?? Effect.void)),
          ),
        );
        const fiber = yield* Effect.forkIn(drain, ownerScope);
        // The map is the arbiter for concurrent starts: the loser interrupts
        // its never-activated fiber and defers to the winner.
        const won = yield* Ref.modify(runtimes, (current) => {
          if (current.has(ref.sessionId)) return [false, current] as const;
          return [
            true,
            new Map(current).set(ref.sessionId, { ref, projection, fiber, applyWire }),
          ] as const;
        });
        if (!won) {
          yield* Fiber.interrupt(fiber);
          return;
        }
        yield* Deferred.succeed(registered, undefined);
      });

    const stop: HarnessAgentSessionRuntimeShape["stop"] = (ref) =>
      Ref.get(runtimes).pipe(
        Effect.flatMap((current) => {
          const runtime = current.get(ref.sessionId);
          return runtime
            ? Fiber.interrupt(runtime.fiber).pipe(
                Effect.andThen(removeOwned(ref.sessionId, runtime.projection)),
              )
            : Effect.void;
        }),
      );

    return {
      start,
      stop,
      snapshot: (ref) =>
        getRuntime(ref).pipe(
          Effect.flatMap((runtime) => Ref.get(runtime.projection)),
          Effect.map((projection) => toSnapshot(ref, projection)),
        ),
      status: (ref) =>
        getRuntime(ref).pipe(
          Effect.flatMap((runtime) => Ref.get(runtime.projection)),
          Effect.map(toStatus),
        ),
      emit: (ref, body) =>
        getRuntime(ref).pipe(Effect.flatMap((runtime) => runtime.applyWire(body))),
    };
  });
