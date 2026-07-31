import type {
  AgentRequest,
  SessionMessageChunkEvent,
  SessionPhase,
  SessionRef,
  SessionRuntimeSnapshot,
  SessionScopedEvent,
  SessionScopedEventBody,
  SessionStatus,
} from "@vibest/contract";
import { Data, Deferred, Effect, Fiber, Ref, Scope, Stream } from "effect";

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

type ActiveTurn = {
  readonly turnId: string;
  readonly messageId: string | null;
  readonly chunks: ReadonlyArray<SessionMessageChunkEvent>;
  readonly complete: boolean;
};

type Projection = {
  readonly seq: number;
  readonly cursor: number;
  readonly phase: SessionPhase;
  readonly activeTurn: ActiveTurn | null;
  readonly pendingRequests: ReadonlyMap<string, AgentRequest>;
};

const initialProjection: Projection = {
  seq: 0,
  cursor: 0,
  phase: "idle",
  activeTurn: null,
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

const fold = (current: Projection, event: SessionScopedEvent): Projection => {
  const base = { ...current, seq: event.seq, cursor: event.seq };
  switch (event.type) {
    case "session.turn.started":
      // Starting a turn releases the previous turn's retained buffer.
      return {
        ...base,
        phase: "running",
        activeTurn: { turnId: event.turnId, messageId: null, chunks: [], complete: false },
      };
    case "session.message.chunk": {
      if (
        !current.activeTurn ||
        current.activeTurn.complete ||
        current.activeTurn.turnId !== event.turnId
      ) {
        return base;
      }
      return {
        ...base,
        activeTurn: {
          ...current.activeTurn,
          messageId: current.activeTurn.messageId ?? startChunkMessageId(event.chunk),
          chunks: [...current.activeTurn.chunks, event],
        },
      };
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
      return { ...base, phase: "crashed", activeTurn: null, pendingRequests: new Map() };
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
      }
    : null,
  cursor: projection.cursor,
});

const toStatus = (projection: Projection): SessionStatus => ({
  phase: projection.phase,
  ...(projection.activeTurn && !projection.activeTurn.complete
    ? { activeTurnId: projection.activeTurn.turnId }
    : {}),
});

// One live in-memory session (ours): projection + seq + the fiber draining the
// HarnessAgent's native event stream. The runtime owns a map of these.
type SessionRuntime = {
  readonly ref: SessionRef;
  readonly projection: Ref.Ref<Projection>;
  readonly fiber: Fiber.Fiber<void>;
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

        const apply = (body: SessionEnvelopeBody) =>
          Ref.get(projection).pipe(
            Effect.flatMap((current) => {
              const activeTurn =
                current.activeTurn && !current.activeTurn.complete
                  ? current.activeTurn.turnId
                  : undefined;
              const wireBody = toWireBody(body, activeTurn);
              if (!wireBody) return Effect.void;
              const event: SessionScopedEvent = { seq: current.seq + 1, ref, ...wireBody };
              return Ref.set(projection, fold(current, event)).pipe(
                Effect.andThen(bus.publish(event)),
              );
            }),
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
          return [true, new Map(current).set(ref.sessionId, { ref, projection, fiber })] as const;
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
    };
  });
