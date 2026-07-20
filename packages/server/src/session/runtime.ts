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
import { Context, Data, Effect, Fiber, Layer, Ref, Scope, Stream } from "effect";

import { EventBus, type EventBusShape } from "../events/event-bus";
import {
  type AgentOperationError,
  isSessionEvent,
  type SessionEnvelopeBody,
  type SessionEvent,
} from "../harness";

/** The AI-SDK UI chunk type, sourced from the contract to avoid an `ai` dependency. */
type WireChunk = SessionMessageChunkEvent["chunk"];

/**
 * A per-session runtime. The harness streams native-`sessionId`-keyed drafts;
 * this owns the server-side truth the harness sheds: it stamps a per-session,
 * contiguous `seq`, folds the projection (phase machine, active-turn buffer,
 * pending requests, cursor), translates drafts into the wire
 * {@link SessionScopedEvent} (attaching the {@link SessionRef}), and publishes
 * onto the {@link EventBus}. Snapshot/status read the projection.
 */

export class SessionNotActive extends Data.TaggedError("SessionNotActive")<{
  readonly sessionId: string;
}> {}

type ActiveTurn = {
  readonly turnId: string;
  readonly messageId: string | null;
  readonly chunks: ReadonlyArray<SessionMessageChunkEvent>;
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
      return {
        ...base,
        phase: "running",
        activeTurn: { turnId: event.turnId, messageId: null, chunks: [] },
      };
    case "session.message.chunk": {
      if (!current.activeTurn || current.activeTurn.turnId !== event.turnId) return base;
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
      // Turn complete: release the active-turn buffer; history reads take over.
      return { ...base, phase: "idle", activeTurn: null };
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
      }
    : null,
  cursor: projection.cursor,
});

const toStatus = (projection: Projection): SessionStatus => ({
  phase: projection.phase,
  ...(projection.activeTurn ? { activeTurnId: projection.activeTurn.turnId } : {}),
});

// One live in-memory session (ours): projection + seq + the fiber draining the
// HarnessAgent's native event stream. The SessionManager owns a map of these.
type SessionRuntime = {
  readonly ref: SessionRef;
  readonly projection: Ref.Ref<Projection>;
  readonly fiber: Fiber.Fiber<void>;
};

export type SessionManagerShape = {
  /** Begin draining a session's native draft stream: stamp, fold, and fan out. */
  readonly start: (
    ref: SessionRef,
    events: Stream.Stream<SessionEnvelopeBody, AgentOperationError>,
  ) => Effect.Effect<void>;
  readonly stop: (ref: SessionRef) => Effect.Effect<void>;
  readonly snapshot: (ref: SessionRef) => Effect.Effect<SessionRuntimeSnapshot, SessionNotActive>;
  readonly status: (ref: SessionRef) => Effect.Effect<SessionStatus, SessionNotActive>;
};

export class SessionManager extends Context.Service<SessionManager, SessionManagerShape>()(
  "SessionManager",
) {}

export const makeSessionManager = (
  bus: EventBusShape,
): Effect.Effect<SessionManagerShape, never, Scope.Scope> =>
  Effect.gen(function* () {
    const ownerScope = yield* Scope.Scope;
    const runtimes = yield* Ref.make<ReadonlyMap<string, SessionRuntime>>(new Map());

    const remove = (sessionId: string) =>
      Ref.update(runtimes, (current) => {
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

    const start: SessionManagerShape["start"] = (ref, events) =>
      Effect.gen(function* () {
        const projection = yield* Ref.make(initialProjection);

        const apply = (body: SessionEnvelopeBody) =>
          Ref.get(projection).pipe(
            Effect.flatMap((current) => {
              const wireBody = toWireBody(body, current.activeTurn?.turnId);
              if (!wireBody) return Effect.void;
              const event: SessionScopedEvent = { seq: current.seq + 1, ref, ...wireBody };
              return Ref.set(projection, fold(current, event)).pipe(
                Effect.andThen(bus.publish(event)),
              );
            }),
          );

        const crash = (reason: string) =>
          apply({ type: "session.crashed", sessionId: ref.sessionId, reason });

        const drain = Stream.runForEach(events, apply).pipe(
          Effect.catch((error) => crash(error.message)),
          Effect.ensuring(remove(ref.sessionId)),
        );
        const fiber = yield* Effect.forkIn(drain, ownerScope);
        yield* Ref.update(runtimes, (current) =>
          new Map(current).set(ref.sessionId, { ref, projection, fiber }),
        );
      });

    const stop: SessionManagerShape["stop"] = (ref) =>
      Ref.get(runtimes).pipe(
        Effect.flatMap((current) => {
          const runtime = current.get(ref.sessionId);
          return runtime
            ? Fiber.interrupt(runtime.fiber).pipe(Effect.andThen(remove(ref.sessionId)))
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

export const SessionManagerLayer: Layer.Layer<SessionManager, never, EventBus> = Layer.effect(
  SessionManager,
  Effect.gen(function* () {
    const bus = yield* EventBus;
    return yield* makeSessionManager(bus);
  }),
);
