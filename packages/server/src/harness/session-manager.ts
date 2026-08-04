import type {
  HarnessAgentId,
  SessionRef,
  SessionRuntimeSnapshot,
  SessionScopedEventBody,
  SessionStatus,
} from "@vibest/contract";
import { Context, Deferred, Effect, Exit, FileSystem, Layer, Ref, Scope, Stream } from "effect";

import { EventBus, type EventBusShape } from "../events/event-bus";
import type { CreateSessionInput, HarnessAgentRuntime } from "./adapter";
import {
  AgentOpenError,
  AgentUnavailable,
  type CreateSessionError,
  HarnessSessionNotFound,
  type ResumeSessionError,
  SessionNotResumable,
} from "./errors";
import type { HarnessAgentRegistryShape } from "./registry";
import { HarnessAgentRegistry } from "./registry";
import { type HarnessAgentSessionShape, makeHarnessAgentSession } from "./session";
import { initialSessionState, toSnapshot, toStatus } from "./session-fold";
import type { ResumeManagedSessionInput } from "./session-io";

/**
 * The sole owner of live session state: the {@link HarnessAgentSession} per
 * ref, and the native runtime table behind it — which runtimes are open, which
 * are mid-open, which are closing. It is the single caller of `adapter.open` /
 * `adapter.resume`, so per-sessionId single-flighting lives here and nowhere
 * else — adapters may assume they are never asked to open the same session
 * twice concurrently — and a built runtime is always draining into its
 * session, by construction rather than by caller discipline.
 *
 * Vocabulary: everything here is addressed by {@link SessionRef}, which is
 * carried opaquely — stamped onto wire events and used as the map key — never
 * interpreted. The agent-native session id survives only as a value the
 * adapters trade in; adapters never see the ref.
 */

type ManagedRuntime = {
  readonly runtime: HarnessAgentRuntime;
  readonly scope: Scope.Closeable;
};

type ManagerState = {
  readonly active: ReadonlyMap<string, ManagedRuntime>;
  readonly inFlight: ReadonlyMap<string, Deferred.Deferred<ManagedRuntime, ResumeSessionError>>;
  readonly closing: ReadonlyMap<string, Deferred.Deferred<void>>;
};

type EnsureDecision =
  | { readonly _tag: "Active"; readonly managed: ManagedRuntime }
  | { readonly _tag: "WaitForClose"; readonly deferred: Deferred.Deferred<void> }
  | {
      readonly _tag: "Start";
      readonly deferred: Deferred.Deferred<ManagedRuntime, ResumeSessionError>;
    }
  | {
      readonly _tag: "Wait";
      readonly deferred: Deferred.Deferred<ManagedRuntime, ResumeSessionError>;
    };

type CloseDecision =
  | { readonly _tag: "Done" }
  | { readonly _tag: "Wait"; readonly deferred: Deferred.Deferred<void> }
  | {
      readonly _tag: "Start";
      readonly managed: ManagedRuntime;
      readonly deferred: Deferred.Deferred<void>;
    }
  | {
      readonly _tag: "StartAfterBuild";
      readonly build: Deferred.Deferred<ManagedRuntime, ResumeSessionError>;
      readonly deferred: Deferred.Deferred<void>;
    };

export type HarnessAgentSessionManagerShape = {
  /**
   * Open a fresh native session via the adapter, take ownership of it, and
   * start draining its event stream into the projection under `ref`.
   */
  readonly open: (
    harnessAgentId: HarnessAgentId,
    input: CreateSessionInput,
    ref: SessionRef,
  ) => Effect.Effect<HarnessAgentRuntime, CreateSessionError>;
  /**
   * Idempotently make sure a native session is open and draining: an active
   * one returns immediately, a concurrent ensure joins the in-flight build,
   * and an in-progress close is awaited before reopening. Safe to call from
   * every path that merely needs the session alive.
   */
  readonly ensure: (
    input: ResumeManagedSessionInput,
    ref: SessionRef,
  ) => Effect.Effect<void, ResumeSessionError>;
  /** The live runtime behind a ref; fails when the session has none open. */
  readonly get: (ref: SessionRef) => Effect.Effect<HarnessAgentRuntime, HarnessSessionNotFound>;
  /**
   * Close and forget a session — runtime and session state alike; idempotent,
   * concurrent closes share one run. This is the only path that discards a
   * crashed session (a crash alone releases the runtime but keeps the session
   * queryable at phase "crashed" for reconnecting clients).
   */
  readonly close: (ref: SessionRef) => Effect.Effect<void>;
  /**
   * The status/snapshot of a session. Total on purpose: a ref with nothing
   * live in memory — the ordinary state of every persisted session after a
   * server restart — reads as idle at cursor 0 rather than failing. That is
   * what lets a client attach, snapshot, and subscribe without anything
   * starting a process on its behalf.
   *
   * Neither call creates a session; only the write paths do.
   */
  readonly status: (ref: SessionRef) => Effect.Effect<SessionStatus>;
  readonly snapshot: (ref: SessionRef) => Effect.Effect<SessionRuntimeSnapshot>;
  /**
   * The status of a session that is live in memory, or `undefined` when it is
   * not. The distinction `status` deliberately erases, for the one caller that
   * needs it: `list` must show an untouched session as having no status at
   * all, not as a freshly idle one.
   */
  readonly liveStatus: (ref: SessionRef) => Effect.Effect<SessionStatus | undefined>;
  /**
   * Inject a server-originated session event into the session's stream — same
   * seq counter and fan-out as harness events (see session `emit`). A write,
   * so it materializes the session if this is the first thing to touch it.
   */
  readonly emit: (ref: SessionRef, body: SessionScopedEventBody) => Effect.Effect<void>;
};

export class HarnessAgentSessionManager extends Context.Service<
  HarnessAgentSessionManager,
  HarnessAgentSessionManagerShape
>()("HarnessAgentSessionManager") {}

export const makeHarnessAgentSessionManager = (
  registry: HarnessAgentRegistryShape,
  bus: EventBusShape,
): Effect.Effect<HarnessAgentSessionManagerShape, never, Scope.Scope | FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const ownerScope = yield* Scope.Scope;
    // An adapter's availability check reads the filesystem; bind it once here
    // so the manager's own methods stay R-free. `provideService` rather than
    // `provide(Effect.context())` — the latter captures the whole layer-build
    // context, `ownerScope` included, and wins the merge over a caller's.
    const fileSystem = yield* FileSystem.FileSystem;
    const state = yield* Ref.make<ManagerState>({
      active: new Map(),
      inFlight: new Map(),
      closing: new Map(),
    });
    // Our sessionId → the session that owns its observable state.
    const sessions = yield* Ref.make<ReadonlyMap<string, HarnessAgentSessionShape>>(new Map());
    // Sessions are two Refs and a pair of semaphores, so losing the race and
    // discarding one costs nothing — cheaper than serializing every lookup.
    const sessionFor = (ref: SessionRef): Effect.Effect<HarnessAgentSessionShape> =>
      Ref.get(sessions).pipe(
        Effect.flatMap((current) => {
          const existing = current.get(ref.sessionId);
          if (existing) return Effect.succeed(existing);
          return makeHarnessAgentSession(ref, bus).pipe(
            Effect.provideService(Scope.Scope, ownerScope),
            Effect.flatMap((candidate) =>
              Ref.modify(sessions, (latest) => {
                const raced = latest.get(ref.sessionId);
                if (raced) return [raced, latest] as const;
                return [candidate, new Map(latest).set(ref.sessionId, candidate)] as const;
              }),
            ),
          );
        }),
      );

    /** Read through a live session, or answer for one that isn't there. */
    const withSession = <A>(
      ref: SessionRef,
      use: (session: HarnessAgentSessionShape) => Effect.Effect<A>,
      absent: A,
    ): Effect.Effect<A> =>
      Ref.get(sessions).pipe(
        Effect.flatMap((current) => {
          const session = current.get(ref.sessionId);
          return session ? use(session) : Effect.succeed(absent);
        }),
      );

    const register = (candidate: ManagedRuntime, ref: SessionRef) =>
      Ref.modify(state, (current) => {
        const existing = current.active.get(ref.sessionId);
        if (existing) return [existing, current] as const;
        return [
          candidate,
          { ...current, active: new Map(current.active).set(ref.sessionId, candidate) },
        ] as const;
      }).pipe(
        Effect.tap((registered) =>
          registered === candidate
            ? Effect.void
            : candidate.runtime.close.pipe(Effect.andThen(Scope.close(candidate.scope, Exit.void))),
        ),
      );

    const checkAvailable = (harnessAgentId: HarnessAgentId) =>
      registry.get(harnessAgentId).pipe(
        Effect.tap((adapter) =>
          adapter.checkAvailability.pipe(
            Effect.flatMap((availability) =>
              availability.available
                ? Effect.void
                : Effect.fail(
                    new AgentUnavailable({
                      harnessAgentId,
                      reason: availability.reason ?? "Unavailable",
                    }),
                  ),
            ),
            Effect.provideService(FileSystem.FileSystem, fileSystem),
          ),
        ),
      );

    const getManaged = (ref: SessionRef): Effect.Effect<ManagedRuntime, HarnessSessionNotFound> =>
      Ref.get(state).pipe(
        Effect.flatMap((current) => {
          const managed = current.active.get(ref.sessionId);
          return managed
            ? Effect.succeed(managed)
            : Effect.fail(new HarnessSessionNotFound({ sessionId: ref.sessionId }));
        }),
      );

    const closeManaged = (managed: ManagedRuntime) =>
      managed.runtime.close.pipe(
        Effect.ensuring(Scope.close(managed.scope, Exit.void)),
        Effect.asVoid,
      );

    /** The instance-only close: the three-state machine over active/inFlight/closing. */
    const closeInstance = (sessionId: string): Effect.Effect<void> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const candidate = yield* Deferred.make<void>();
          const decision = yield* Ref.modify<ManagerState, CloseDecision>(state, (current) => {
            const inProgress = current.closing.get(sessionId);
            if (inProgress) return [{ _tag: "Wait", deferred: inProgress }, current];
            const managed = current.active.get(sessionId);
            const inFlightBuild = current.inFlight.get(sessionId);
            if (!managed) {
              if (!inFlightBuild) return [{ _tag: "Done" }, current];
              return [
                { _tag: "StartAfterBuild", build: inFlightBuild, deferred: candidate },
                {
                  ...current,
                  closing: new Map(current.closing).set(sessionId, candidate),
                },
              ];
            }
            const closing = new Map(current.closing).set(sessionId, candidate);
            const active = new Map(current.active);
            active.delete(sessionId);
            return [
              { _tag: "Start", managed, deferred: candidate },
              { ...current, active, closing },
            ];
          });
          if (decision._tag === "Done") return;
          if (decision._tag === "Start" || decision._tag === "StartAfterBuild") {
            const finish = Deferred.succeed(decision.deferred, undefined).pipe(
              Effect.andThen(
                Ref.update(state, (current) => {
                  if (current.closing.get(sessionId) !== decision.deferred) return current;
                  const closing = new Map(current.closing);
                  closing.delete(sessionId);
                  return { ...current, closing };
                }),
              ),
            );
            const worker =
              decision._tag === "Start"
                ? closeManaged(decision.managed)
                : Deferred.await(decision.build).pipe(
                    Effect.flatMap((managed) =>
                      Ref.update(state, (current) => {
                        if (current.active.get(sessionId) !== managed) return current;
                        const active = new Map(current.active);
                        active.delete(sessionId);
                        return { ...current, active };
                      }).pipe(Effect.andThen(closeManaged(managed))),
                    ),
                    Effect.catch(() => Effect.void),
                  );
            yield* Effect.forkIn(worker.pipe(Effect.ensuring(finish)), ownerScope);
          }
          yield* restore(Deferred.await(decision.deferred));
        }),
      );

    // A crash releases the runtime but keeps the session + index (see `close`).
    const startDrain = (managed: ManagedRuntime, ref: SessionRef) =>
      sessionFor(ref).pipe(
        Effect.flatMap((session) =>
          session.attach(managed.runtime.events.pipe(Stream.map((draft) => draft.body)), {
            onCrash: closeInstance(ref.sessionId),
          }),
        ),
      );

    const build = (
      mode:
        | {
            readonly _tag: "Open";
            readonly harnessAgentId: HarnessAgentId;
            readonly input: CreateSessionInput;
          }
        | { readonly _tag: "Resume"; readonly input: ResumeManagedSessionInput },
      ref: SessionRef,
    ) =>
      Effect.gen(function* () {
        const harnessAgentId =
          mode._tag === "Open" ? mode.harnessAgentId : mode.input.harnessAgentId;
        const adapter = yield* checkAvailable(harnessAgentId);
        const sessionScope = yield* Scope.fork(ownerScope, "sequential");
        return yield* Effect.gen(function* () {
          const opened = yield* (
            mode._tag === "Open"
              ? adapter.open(mode.input)
              : adapter.resume({
                  sessionId: mode.input.sessionId,
                  cwd: mode.input.cwd,
                })
          ).pipe(Effect.provideService(Scope.Scope, sessionScope));
          const managed = yield* register({ runtime: opened, scope: sessionScope }, ref);
          // Both the register winner and a deduped loser pass through here:
          // `attach` treats an already-draining session as a no-op.
          yield* startDrain(managed, ref);
          return managed;
        }).pipe(Effect.onError(() => Scope.close(sessionScope, Exit.void)));
      });

    const dropSession = (ref: SessionRef): Effect.Effect<void> =>
      Ref.modify(sessions, (current) => {
        const session = current.get(ref.sessionId);
        if (!session) return [undefined, current] as const;
        const next = new Map(current);
        next.delete(ref.sessionId);
        return [session, next] as const;
      }).pipe(Effect.flatMap((session) => session?.detach ?? Effect.void));

    const close = (ref: SessionRef): Effect.Effect<void> =>
      dropSession(ref).pipe(Effect.andThen(closeInstance(ref.sessionId)));

    const ensure = (
      input: ResumeManagedSessionInput,
      ref: SessionRef,
    ): Effect.Effect<void, ResumeSessionError> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const candidate = yield* Deferred.make<ManagedRuntime, ResumeSessionError>();
          const decision = yield* Ref.modify<ManagerState, EnsureDecision>(state, (current) => {
            const closing = current.closing.get(ref.sessionId);
            if (closing) return [{ _tag: "WaitForClose", deferred: closing }, current];
            const active = current.active.get(ref.sessionId);
            if (active) return [{ _tag: "Active", managed: active }, current];
            const inFlight = current.inFlight.get(ref.sessionId);
            if (inFlight) return [{ _tag: "Wait", deferred: inFlight }, current];
            return [
              { _tag: "Start", deferred: candidate },
              { ...current, inFlight: new Map(current.inFlight).set(ref.sessionId, candidate) },
            ];
          });
          if (decision._tag === "Active") {
            // Already open, but a crashed session may need reviving — attach is
            // a no-op on a live one.
            yield* startDrain(decision.managed, ref);
            return;
          }
          if (decision._tag === "WaitForClose") {
            yield* restore(Deferred.await(decision.deferred));
            return yield* ensure(input, ref);
          }
          if (decision._tag === "Start") {
            yield* Effect.forkIn(
              build({ _tag: "Resume", input }, ref).pipe(
                Effect.exit,
                Effect.flatMap((exit) => Deferred.done(decision.deferred, exit)),
                Effect.ensuring(
                  Ref.update(state, (current) => {
                    if (current.inFlight.get(ref.sessionId) !== decision.deferred) return current;
                    const inFlight = new Map(current.inFlight);
                    inFlight.delete(ref.sessionId);
                    return { ...current, inFlight };
                  }),
                ),
              ),
              ownerScope,
            );
          }
          yield* restore(Effect.asVoid(Deferred.await(decision.deferred)));
        }),
      );

    yield* Scope.addFinalizer(
      ownerScope,
      Ref.get(state).pipe(
        Effect.flatMap((current) =>
          Effect.forEach(current.active.values(), closeManaged, {
            concurrency: "unbounded",
            discard: true,
          }),
        ),
      ),
    );

    return {
      open: (harnessAgentId, input, ref) =>
        build({ _tag: "Open", harnessAgentId, input }, ref).pipe(
          Effect.map((managed) => managed.runtime),
          // `build` is shared with the resume path, so its error union carries
          // SessionNotResumable; on the open path that can only mean the
          // adapter misbehaved, so it is folded into AgentOpenError.
          Effect.mapError((error) =>
            error instanceof SessionNotResumable
              ? new AgentOpenError({ harnessAgentId, cause: error })
              : error,
          ),
        ),
      ensure,
      get: (ref) => getManaged(ref).pipe(Effect.map((managed) => managed.runtime)),
      close,
      status: (ref) => withSession(ref, (session) => session.status, toStatus(initialSessionState)),
      snapshot: (ref) =>
        withSession(ref, (session) => session.snapshot, toSnapshot(ref, initialSessionState)),
      liveStatus: (ref) =>
        withSession<SessionStatus | undefined>(ref, (session) => session.status, undefined),
      emit: (ref, body) => sessionFor(ref).pipe(Effect.flatMap((session) => session.emit(body))),
    } satisfies HarnessAgentSessionManagerShape;
  });

export const HarnessAgentSessionManagerLayer = Layer.effect(
  HarnessAgentSessionManager,
  Effect.gen(function* () {
    const registry = yield* HarnessAgentRegistry;
    const bus = yield* EventBus;
    return yield* makeHarnessAgentSessionManager(registry, bus);
  }),
);
