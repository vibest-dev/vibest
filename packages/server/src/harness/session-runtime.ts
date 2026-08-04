import type {
  SessionRef,
  SessionRuntimeSnapshot,
  SessionScopedEvent,
  SessionScopedEventBody,
  SessionStatus,
} from "@vibest/contract";
import { Data, Deferred, Effect, Fiber, Ref, Scope, Semaphore, Stream } from "effect";

import type { EventBusShape } from "../events/event-bus";
import type { AgentOperationError } from "./errors";
import type { SessionEnvelopeBody } from "./events/framework";
import {
  foldSessionEvent,
  initialSessionState,
  type SessionState,
  toSnapshot,
  toStatus,
  toWireBody,
} from "./session-fold";

/**
 * The live view over a session's native event stream. The harness agents
 * stream native-`sessionId`-keyed drafts; this owns the server-side truth they
 * shed: it stamps a per-session, contiguous `seq`, folds the state (phase
 * machine, active-turn buffer, pending requests, cursor — see
 * {@link ./session-fold}), translates drafts into the wire
 * {@link SessionScopedEvent} (attaching the {@link SessionRef}), and publishes
 * onto the EventBus. Snapshot/status read the folded state. It is an internal
 * collaborator of {@link HarnessAgentSessionService} — no Context tag — and
 * never touches processes; instance lifecycle is
 * {@link HarnessAgentSessionManager}'s job.
 */

export class SessionNotActive extends Data.TaggedError("SessionNotActive")<{
  readonly sessionId: string;
}> {}

// One live in-memory session (ours): folded state + seq + the fiber draining
// the HarnessAgent's native event stream, plus the wire-body applier so events
// originating outside the native stream (`emit`) share the same seq counter.
type SessionRuntime = {
  readonly ref: SessionRef;
  readonly state: Ref.Ref<SessionState>;
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
    const removeOwned = (sessionId: string, state: Ref.Ref<SessionState>) =>
      Ref.update(runtimes, (current) => {
        const entry = current.get(sessionId);
        if (!entry || entry.state !== state) return current;
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
          const phase = (yield* Ref.get(existing.state)).phase;
          if (phase !== "crashed") return;
          yield* Fiber.interrupt(existing.fiber);
          yield* removeOwned(ref.sessionId, existing.state);
        }

        const state = yield* Ref.make(initialSessionState);

        // Serializes stamp+publish across the drain fiber and `emit` callers:
        // without it two fibers could stamp seqs n/n+1 but publish n+1 first,
        // and the clients' `seq <= cursor` replay guard would drop n forever.
        const applyLock = Semaphore.makeUnsafe(1);

        // The body builder runs under the same permit as the fold+publish so
        // both read one consistent state — deriving the active turn from
        // a read outside the lock would reintroduce exactly the interleaving
        // the lock exists to stop.
        const applyWith = (
          make: (current: SessionState) => SessionScopedEventBody | null,
        ): Effect.Effect<void> =>
          applyLock.withPermit(
            Ref.get(state).pipe(
              Effect.flatMap((current) => {
                const wireBody = make(current);
                if (!wireBody) return Effect.void;
                const event: SessionScopedEvent = { seq: current.seq + 1, ref, ...wireBody };
                const next = foldSessionEvent(current, event);
                // Publish with the post-fold phase stamped on: consumers copy
                // the session's phase off the event instead of re-deriving it
                // from event types. (The buffered chunk copy inside `next`
                // keeps the un-stamped draft — snapshot replays read phase
                // from the snapshot's own status.)
                return Ref.set(state, next).pipe(
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
        // end drops the runtime; a crash keeps the state queryable (phase
        // "crashed") until close/delete/resume, after `onCrash` released the
        // native session.
        const registered = yield* Deferred.make<void>();
        const drain = Deferred.await(registered).pipe(
          Effect.andThen(Stream.runForEach(events, apply)),
          Effect.andThen(removeOwned(ref.sessionId, state)),
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
            new Map(current).set(ref.sessionId, { ref, state, fiber, applyWire }),
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
                Effect.andThen(removeOwned(ref.sessionId, runtime.state)),
              )
            : Effect.void;
        }),
      );

    return {
      start,
      stop,
      snapshot: (ref) =>
        getRuntime(ref).pipe(
          Effect.flatMap((runtime) => Ref.get(runtime.state)),
          Effect.map((state) => toSnapshot(ref, state)),
        ),
      status: (ref) =>
        getRuntime(ref).pipe(
          Effect.flatMap((runtime) => Ref.get(runtime.state)),
          Effect.map(toStatus),
        ),
      emit: (ref, body) =>
        getRuntime(ref).pipe(Effect.flatMap((runtime) => runtime.applyWire(body))),
    };
  });
