import type {
  SessionRef,
  SessionRuntimeSnapshot,
  SessionScopedEvent,
  SessionScopedEventBody,
  SessionStatus,
} from "@vibest/contract";
import { Deferred, Effect, Fiber, Ref, Scope, Semaphore, Stream } from "effect";

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
 * One session as this server sees it — the owner of everything observable
 * about it: the phase machine, the active turn's buffer, the retained prompt,
 * the pending requests, and the per-session contiguous `seq` that clients use
 * as a replay cursor. It stamps that seq, folds each event into
 * {@link SessionState}, translates native drafts into wire
 * {@link SessionScopedEvent}s (attaching the {@link SessionRef}), and publishes
 * onto the EventBus.
 *
 * What it deliberately is *not* is a process. The live execution resource is a
 * {@link HarnessAgentRuntime}, which a session drains from and — from the
 * commit that makes acquisition lazy — optionally owns. Keeping the two apart
 * is what lets a session outlive its runtime crashing or never having started.
 *
 * A private collaborator of {@link HarnessAgentSessionManager}: no Context tag,
 * and it never opens, resumes, or closes a native session itself.
 */

/** The live drain: the fiber consuming a runtime's native stream, plus the
 * token that lets only its own cleanup evict it. */
type Drain = {
  readonly token: object;
  readonly fiber: Fiber.Fiber<void>;
};

export type HarnessAgentSessionShape = {
  readonly ref: SessionRef;
  /**
   * Begin draining a runtime's native draft stream into this session: stamp,
   * fold, and fan out. Idempotent — a session already draining ignores the
   * call, so concurrent resumes can never split the single-consumer native
   * stream across two fibers. A crashed session is reset and re-drained.
   * `onCrash` runs once if the native stream fails; the manager releases the
   * native session there.
   */
  readonly attach: (
    events: Stream.Stream<SessionEnvelopeBody, AgentOperationError>,
    options?: { readonly onCrash?: Effect.Effect<void> },
  ) => Effect.Effect<void>;
  /** Stop draining. The session and its folded state survive. */
  readonly detach: Effect.Effect<void>;
  /**
   * What this session is doing, always answerable. A session that has never
   * had a runtime reads as idle at cursor 0 — which is the truth, not a
   * placeholder: nothing has happened on it in this process.
   */
  readonly snapshot: Effect.Effect<SessionRuntimeSnapshot>;
  readonly status: Effect.Effect<SessionStatus>;
  /**
   * Inject a server-originated wire event into the session's stream: it gets
   * the same contiguous seq stamping and bus fan-out as harness-driven events.
   * Independent of any runtime — the seq counter is the session's own.
   */
  readonly emit: (body: SessionScopedEventBody) => Effect.Effect<void>;
};

export const makeHarnessAgentSession = (
  ref: SessionRef,
  bus: EventBusShape,
): Effect.Effect<HarnessAgentSessionShape, never, Scope.Scope> =>
  Effect.gen(function* () {
    const ownerScope = yield* Scope.Scope;
    const state = yield* Ref.make(initialSessionState);
    const drain = yield* Ref.make<Drain | undefined>(undefined);

    // Serializes stamp+publish across the drain fiber and `emit` callers:
    // without it two fibers could stamp seqs n/n+1 but publish n+1 first, and
    // the clients' `seq <= cursor` replay guard would drop n forever.
    const applyLock = Semaphore.makeUnsafe(1);
    // Serializes attach/detach against each other, so a fiber is always stored
    // before its own stream can end and try to evict it.
    const lifecycleLock = Semaphore.makeUnsafe(1);

    // The body builder runs under the same permit as the fold+publish so both
    // read one consistent state — deriving the active turn from a read outside
    // the lock would reintroduce exactly the interleaving the lock stops.
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
            // Publish with the post-fold phase stamped on: consumers copy the
            // session's phase off the event instead of re-deriving it from
            // event types. (The buffered chunk copy inside `next` keeps the
            // un-stamped draft — snapshot replays read phase from the
            // snapshot's own status.)
            return Ref.set(state, next).pipe(
              Effect.andThen(bus.publish({ ...event, phase: next.phase })),
            );
          }),
        ),
      );

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

    const attach: HarnessAgentSessionShape["attach"] = (events, options) =>
      lifecycleLock.withPermit(
        Effect.gen(function* () {
          const existing = yield* Ref.get(drain);
          if (existing) {
            // A live drain keeps going; only a crashed one is replaced (its
            // fiber is already dead — interrupt is a harmless formality).
            const phase = (yield* Ref.get(state)).phase;
            if (phase !== "crashed") return;
            yield* Fiber.interrupt(existing.fiber);
            yield* Ref.set(state, initialSessionState);
          }

          const token = {};
          // Identity-guarded: only the drain that owns the entry may clear it,
          // so a superseded fiber's cleanup can never evict its replacement.
          const clearOwned = Ref.update(drain, (current) =>
            current?.token === token ? undefined : current,
          );
          // A natural end drops the drain; a crash keeps it, so the state
          // stays queryable at phase "crashed" until close/delete/re-attach —
          // after `onCrash` has released the native session.
          const registered = yield* Deferred.make<void>();
          const body = Deferred.await(registered).pipe(
            Effect.andThen(Stream.runForEach(events, apply)),
            Effect.andThen(clearOwned),
            Effect.catch((error) =>
              crash(error.message).pipe(Effect.andThen(options?.onCrash ?? Effect.void)),
            ),
          );
          const fiber = yield* Effect.forkIn(body, ownerScope);
          // Storing before releasing the fiber is what makes an instantly
          // ending stream safe: its cleanup cannot run ahead of registration.
          yield* Ref.set(drain, { token, fiber });
          yield* Deferred.succeed(registered, undefined);
        }),
      );

    const detach: HarnessAgentSessionShape["detach"] = lifecycleLock.withPermit(
      Ref.getAndSet(drain, undefined).pipe(
        Effect.flatMap((current) => (current ? Fiber.interrupt(current.fiber) : Effect.void)),
      ),
    );

    return {
      ref,
      attach,
      detach,
      snapshot: Ref.get(state).pipe(Effect.map((current) => toSnapshot(ref, current))),
      status: Ref.get(state).pipe(Effect.map(toStatus)),
      emit: (body) => applyWith(() => body),
    } satisfies HarnessAgentSessionShape;
  });
