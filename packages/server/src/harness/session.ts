import type {
  SessionRef,
  SessionRuntimeSnapshot,
  SessionScopedEvent,
  SessionScopedEventBody,
  SessionStatus,
} from "@vibest/contract";
import { Deferred, Effect, Exit, Fiber, Ref, Scope, Semaphore, Stream } from "effect";

import type { EventBusShape } from "../events/event-bus";
import type { HarnessAgentRuntime } from "./adapter";
import {
  AgentOpenError,
  type AgentOperationError,
  type ResumeSessionError,
  type SessionClosed,
} from "./errors";
import {
  foldSessionEvent,
  initialSessionState,
  type SessionState,
  toSnapshot,
  toStatus,
  toWireBody,
} from "./session-fold";
import { inSession } from "./session-identity";
import type { SessionConfig } from "./session-io";

/**
 * One session as this server sees it — the owner of everything observable
 * about it: the phase machine, the active turn's buffer, the retained prompt,
 * the pending requests, and the per-session contiguous `seq` that clients use
 * as a replay cursor. It stamps that seq, folds each event into
 * {@link SessionState}, translates native drafts into wire
 * {@link SessionScopedEvent}s (attaching the {@link SessionRef}), and publishes
 * onto the EventBus.
 *
 * It *optionally owns* a {@link HarnessAgentRuntime} — the live execution
 * resource: a pi child, a Claude SDK handle, a Codex thread. Optional is the
 * whole point. A session exists as soon as anything writes to it and outlives
 * every runtime it ever holds, so observing one costs no process, and a
 * crashed runtime leaves a session that is still queryable and can start over.
 *
 * A private collaborator of {@link HarnessAgentSessionManager}: no Context tag.
 * It does not know how to open a native session — the manager hands it an
 * `acquire` — but it is the only thing that decides *when* one is opened, so
 * single-flighting lives here and adapters keep their single-caller invariant.
 */

/** What it takes to produce a runtime: an adapter open/resume, already bound to
 * its inputs by the manager. The `Scope` is the runtime's, forked per
 * acquisition and closed when the runtime is released. */
export type AcquireRuntime = Effect.Effect<HarnessAgentRuntime, ResumeSessionError, Scope.Scope>;

/** The runtime a session currently holds, its scope, and the fiber draining
 * its events. The token is what lets only this holding's own cleanup clear the
 * slot, so a dead runtime's crash handler can never evict its replacement. */
type Held = {
  readonly token: object;
  readonly runtime: HarnessAgentRuntime;
  readonly scope: Scope.Closeable;
  readonly fiber: Fiber.Fiber<void>;
};

/** The promise of a runtime that an acquisition is on its way to producing. */
type Ticket = Deferred.Deferred<HarnessAgentRuntime, ResumeSessionError>;

/**
 * Whether this session has a runtime, is getting one, or will never take
 * another — one Ref because the three have to be decided in a single step.
 * Deliberately private: callers see `peekRuntime` / `ensureRuntime` /
 * `releaseRuntime` and nothing of the states in between.
 *
 * `acquiring` is what makes acquisition single-flight, and it is a ticket
 * rather than a lock because the acquiring fiber is the session's own: a
 * caller that gives up (a cancelled request) neither aborts the acquisition
 * nor strands the callers still waiting on it. `sealed` is set the moment a
 * release begins, so a session on its way out can never take a runtime that
 * would then outlive it.
 */
type Lifecycle = {
  readonly held: Held | undefined;
  readonly acquiring: Ticket | undefined;
  readonly sealed: boolean;
};

type AcquireDecision =
  | { readonly _tag: "Held"; readonly runtime: HarnessAgentRuntime }
  | { readonly _tag: "Start"; readonly ticket: Ticket }
  | { readonly _tag: "Await"; readonly ticket: Ticket }
  | { readonly _tag: "Sealed" };

// Seed a freshly acquired runtime with the session's config, using the same
// setters the UI drives mid-session. Runs before the first prompt on that
// runtime, so the config is live by its opening turn — and runs again on every
// runtime the session acquires, so a config choice outlives a restart, a crash,
// or a server that was not running when the client came back.
//
// The two channels fail differently on purpose (harness-concept-ownership §3.3):
// `permissionMode` was validated at the RPC boundary, so failing to apply it is
// a real fault and the acquisition fails with it. `model`/`reasoningEffort` come
// from probed lists that go stale (an old URL, a re-mapped alias), so they are
// best-effort: a miss is logged and the session runs on the harness default
// rather than turning "the list was a bit old" into "the session cannot start".
const seedConfig = (
  runtime: HarnessAgentRuntime,
  config: SessionConfig,
): Effect.Effect<void, AgentOpenError> =>
  Effect.gen(function* () {
    if (config.permissionMode) {
      yield* runtime
        .setPermissionMode(config.permissionMode)
        .pipe(
          Effect.mapError(
            (cause) => new AgentOpenError({ harnessAgentId: runtime.harnessAgentId, cause }),
          ),
        );
    }
    if (config.model) {
      yield* runtime
        .setModel(config.model)
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning("session model apply failed; using the harness default", cause),
          ),
        );
    }
    if (config.reasoningEffort) {
      yield* runtime
        .setReasoningEffort(config.reasoningEffort)
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning(
              "session reasoningEffort apply failed; using the model default",
              cause,
            ),
          ),
        );
    }
  });

// The same knobs, pushed to a runtime because the user just turned one. Every
// failure surfaces: they are watching the control they touched, so "the model
// list was stale" is news here, not something to log and swallow. Model before
// reasoning effort — codex clears the effort when the model changes, so the
// other order would drop it.
const pushConfig = (
  runtime: HarnessAgentRuntime,
  patch: SessionConfig,
): Effect.Effect<void, SessionClosed | AgentOperationError> =>
  Effect.gen(function* () {
    if (patch.permissionMode) yield* runtime.setPermissionMode(patch.permissionMode);
    if (patch.model) yield* runtime.setModel(patch.model);
    if (patch.reasoningEffort) yield* runtime.setReasoningEffort(patch.reasoningEffort);
  });

export type HarnessAgentSessionShape = {
  readonly ref: SessionRef;
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
  /**
   * Record what this session's config should be, and push it to the runtime if
   * one is live. Recording is the point: a session with nothing running still
   * accepts a model change, and every runtime it acquires afterwards is seeded
   * with it — which is also how a create-time choice reaches the first turn.
   */
  readonly setConfig: (
    patch: SessionConfig,
  ) => Effect.Effect<void, SessionClosed | AgentOperationError>;
  /** The runtime this session holds, or `undefined`. Never acquires one. */
  readonly peekRuntime: Effect.Effect<HarnessAgentRuntime | undefined>;
  /**
   * The session's runtime, acquiring one if it has none. Single-flight:
   * concurrent callers share one acquisition, so an adapter is never asked to
   * open the same session twice at once, and a caller that gives up does not
   * take the others down with it. A failed acquisition holds nothing, so the
   * session stays observable and a later call retries.
   *
   * `undefined` means this session was released out from under the call and
   * will never take another runtime; the caller must ask the manager again,
   * which is where waiting for the release and starting a fresh session live.
   */
  readonly ensureRuntime: (
    acquire: AcquireRuntime,
  ) => Effect.Effect<HarnessAgentRuntime | undefined, ResumeSessionError>;
  /**
   * Release the runtime and seal the session against taking another. The
   * observable state survives — the manager decides when to stop answering for
   * this ref. Idempotent, and waits for an acquisition already in flight
   * rather than racing it.
   */
  readonly releaseRuntime: Effect.Effect<void>;
};

export const makeHarnessAgentSession = (
  ref: SessionRef,
  bus: EventBusShape,
): Effect.Effect<HarnessAgentSessionShape, never, Scope.Scope> =>
  Effect.gen(function* () {
    const ownerScope = yield* Scope.Scope;
    const state = yield* Ref.make(initialSessionState);
    const config = yield* Ref.make<SessionConfig>({});
    const lifecycle = yield* Ref.make<Lifecycle>({
      held: undefined,
      acquiring: undefined,
      sealed: false,
    });

    // Serializes stamp+publish across the drain fiber and `emit` callers:
    // without it two fibers could stamp seqs n/n+1 but publish n+1 first, and
    // the clients' `seq <= cursor` replay guard would drop n forever.
    const applyLock = Semaphore.makeUnsafe(1);

    const identified = inSession(ref);

    const logTurn = (body: SessionScopedEventBody, seq: number): Effect.Effect<void> => {
      if (body.type === "session.turn.started") {
        return Effect.logInfo("turn started").pipe(
          Effect.annotateLogs({ event: body.type, turnId: body.turnId, seq }),
        );
      }
      if (body.type !== "session.turn.ended") return Effect.void;
      const message = body.outcome === "failed" ? Effect.logWarning : Effect.logInfo;
      return message("turn ended").pipe(
        Effect.annotateLogs({
          event: body.type,
          turnId: body.turnId,
          outcome: body.outcome,
          seq,
          ...(body.usage ? { usage: body.usage } : {}),
          ...(body.error ? { errorCategory: body.error.category, error: body.error.message } : {}),
        }),
      );
    };

    // The body builder runs under the same permit as the fold+publish so both
    // read one consistent state — deriving the active turn from a read outside
    // the lock would reintroduce exactly the interleaving the lock stops.
    const applyWith = (
      make: (current: SessionState) => SessionScopedEventBody | null,
    ): Effect.Effect<void> =>
      identified(
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
                Effect.andThen(logTurn(wireBody, event.seq)),
              );
            }),
          ),
        ),
      );

    const apply = (body: Parameters<typeof toWireBody>[0]) =>
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

    // A session that starts over is idle again — the crash was the *runtime*
    // ending, not the session. seq and cursor carry across on purpose: clients
    // hold a cursor from before the crash, and restarting the count at 0 would
    // make every later event look like one they had already applied.
    const clearCrash = applyLock.withPermit(
      Ref.update(state, (current) =>
        current.phase === "crashed"
          ? {
              ...current,
              phase: "idle" as const,
              activeTurn: null,
              activePrompt: null,
              acceptedPrompts: [],
              pendingPrompts: [],
              pendingRequests: new Map(),
            }
          : current,
      ),
    );

    /** Identity-guarded, so a dying runtime disowns itself and only itself —
     * it can never evict the replacement that came after it. */
    const clearHeld = (token: object): Effect.Effect<Held | undefined> =>
      Ref.modify(lifecycle, (current) =>
        current.held?.token === token
          ? [current.held, { ...current, held: undefined }]
          : [undefined, current],
      );

    const takeHeld: Effect.Effect<Held | undefined> = Ref.modify(lifecycle, (current) => [
      current.held,
      { ...current, held: undefined },
    ]);

    const dispose = (current: Held): Effect.Effect<void> =>
      current.runtime.close.pipe(Effect.ensuring(Scope.close(current.scope, Exit.void)));

    const shutDown = (current: Held | undefined): Effect.Effect<void> =>
      current ? Fiber.interrupt(current.fiber).pipe(Effect.andThen(dispose(current))) : Effect.void;

    /** Runs in a fiber of the session's own scope, never the caller's, so the
     * acquisition survives whoever asked for it losing interest. */
    const runAcquire = (acquire: AcquireRuntime, ticket: Ticket): Effect.Effect<void> =>
      Effect.gen(function* () {
        const scope = yield* Scope.fork(ownerScope, "sequential");
        const desired = yield* Ref.get(config);
        const outcome = yield* acquire.pipe(
          Effect.provideService(Scope.Scope, scope),
          // Seeded as part of the acquisition, so a runtime whose config can't
          // be applied never becomes this session's — closing the scope takes
          // it back down the same way a failed open does.
          Effect.tap((runtime) => seedConfig(runtime, desired)),
          Effect.onError(() => Scope.close(scope, Exit.void)),
          Effect.exit,
        );
        if (Exit.isFailure(outcome)) {
          // Nothing is held on failure: the session stays observable and the
          // next call gets to try again.
          yield* Ref.update(lifecycle, (current) =>
            current.acquiring === ticket ? { ...current, acquiring: undefined } : current,
          );
          yield* Deferred.done(ticket, outcome);
          return;
        }
        const runtime = outcome.value;
        yield* clearCrash;

        const token = {};
        const release = clearHeld(token).pipe(
          Effect.flatMap((owned) => (owned ? dispose(owned) : Effect.void)),
        );
        // Either ending releases the runtime; only a failing stream is a
        // crash. The drain waits to be stored first, so an instantly ending
        // stream cannot clear a slot that was never filled.
        const registered = yield* Deferred.make<void>();
        const drain = Deferred.await(registered).pipe(
          Effect.andThen(Stream.runForEach(runtime.events, (draft) => apply(draft.body))),
          Effect.andThen(release),
          Effect.catch((error) => crash(error.message).pipe(Effect.andThen(release))),
        );
        const fiber = yield* Effect.forkIn(drain, ownerScope);
        // A release that started while this was in flight leaves `acquiring`
        // in place precisely so the runtime lands here first — it then takes
        // it back out and shuts it down, instead of losing track of it.
        yield* Ref.update(lifecycle, (current) =>
          current.acquiring === ticket
            ? { ...current, acquiring: undefined, held: { token, runtime, scope, fiber } }
            : current,
        );
        yield* Deferred.succeed(ticket, runtime);
        yield* Deferred.succeed(registered, undefined);
      });

    const ensureRuntime: HarnessAgentSessionShape["ensureRuntime"] = (acquire) =>
      Ref.modify(lifecycle, (current): readonly [AcquireDecision, Lifecycle] => {
        if (current.sealed) return [{ _tag: "Sealed" }, current];
        if (current.held) return [{ _tag: "Held", runtime: current.held.runtime }, current];
        if (current.acquiring) return [{ _tag: "Await", ticket: current.acquiring }, current];
        const ticket = Deferred.makeUnsafe<HarnessAgentRuntime, ResumeSessionError>();
        return [
          { _tag: "Start", ticket },
          { ...current, acquiring: ticket },
        ];
      }).pipe(
        // Publishing the ticket and forking the fiber that completes it have
        // to land together — an interrupt in between would leave every waiter
        // parked on a ticket nobody owns.
        Effect.tap((decision) =>
          decision._tag === "Start"
            ? Effect.forkIn(runAcquire(acquire, decision.ticket), ownerScope)
            : Effect.void,
        ),
        Effect.uninterruptible,
        Effect.flatMap((decision) => {
          switch (decision._tag) {
            case "Sealed":
              return Effect.succeed(undefined);
            case "Held":
              return Effect.succeed(decision.runtime);
            case "Start":
            case "Await":
              return Deferred.await(decision.ticket);
          }
        }),
      );

    const releaseRuntime: HarnessAgentSessionShape["releaseRuntime"] = Ref.modify(
      lifecycle,
      (current) =>
        [current, { held: undefined, acquiring: current.acquiring, sealed: true }] as const,
    ).pipe(
      Effect.flatMap((previous) =>
        previous.acquiring
          ? // An acquisition already in flight owns a runtime it is about to
            // store; wait for it and take that one, or the process it started
            // would outlive the session that asked for it.
            Deferred.await(previous.acquiring).pipe(
              Effect.exit,
              Effect.andThen(takeHeld),
              Effect.flatMap(shutDown),
            )
          : shutDown(previous.held),
      ),
      Effect.uninterruptible,
    );

    const setConfig: HarnessAgentSessionShape["setConfig"] = (patch) =>
      Ref.update(config, (current) => ({ ...current, ...patch })).pipe(
        Effect.andThen(Ref.get(lifecycle)),
        Effect.flatMap((current) =>
          current.held ? pushConfig(current.held.runtime, patch) : Effect.void,
        ),
      );

    return {
      ref,
      snapshot: Ref.get(state).pipe(Effect.map((current) => toSnapshot(ref, current))),
      status: Ref.get(state).pipe(Effect.map(toStatus)),
      emit: (body) => applyWith(() => body),
      setConfig,
      peekRuntime: Ref.get(lifecycle).pipe(Effect.map((current) => current.held?.runtime)),
      ensureRuntime,
      releaseRuntime,
    } satisfies HarnessAgentSessionShape;
  });
