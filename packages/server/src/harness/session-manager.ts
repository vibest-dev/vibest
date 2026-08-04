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
import {
  type HarnessAgentSessionShape,
  makeHarnessAgentSession,
  SessionNotActive,
} from "./session";
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
 * Vocabulary: runtime addressing (`get`/`close`) speaks the agent-native
 * session id; the {@link SessionRef} received by `open`/`ensure` is carried
 * opaquely — stamped onto wire events and used as the session key — never
 * interpreted. Adapters never see it.
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
  /** The live session for a native id; fails when it is not open. */
  readonly get: (sessionId: string) => Effect.Effect<HarnessAgentRuntime, HarnessSessionNotFound>;
  /**
   * Close and forget a session — instance, projection, and index; idempotent,
   * concurrent closes share one run. This is the only path that discards a
   * crashed projection (a crash alone closes the instance but keeps the
   * projection queryable at phase "crashed" for reconnecting clients).
   */
  readonly close: (sessionId: string) => Effect.Effect<void>;
  /** The projected status/snapshot for a session's live (or crashed) runtime. */
  readonly status: (ref: SessionRef) => Effect.Effect<SessionStatus, SessionNotActive>;
  readonly snapshot: (ref: SessionRef) => Effect.Effect<SessionRuntimeSnapshot, SessionNotActive>;
  /**
   * Inject a server-originated session event into the live runtime's stream —
   * same seq counter and fan-out as harness events (see runtime `emit`).
   */
  readonly emit: (
    ref: SessionRef,
    body: SessionScopedEventBody,
  ) => Effect.Effect<void, SessionNotActive>;
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
    // native sessionId → the ref its session lives under. Deliberately
    // outlives a crashed runtime (the session does too); only an explicit
    // `close` clears it, so a late close can still find and stop the crashed
    // session.
    const refs = yield* Ref.make<ReadonlyMap<string, SessionRef>>(new Map());

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

    const notActive = <A>(ref: SessionRef): Effect.Effect<A, SessionNotActive> =>
      Effect.fail(new SessionNotActive({ sessionId: ref.sessionId }));

    const withSession = <A, E>(
      ref: SessionRef,
      use: (session: HarnessAgentSessionShape) => Effect.Effect<A, E>,
      absent: Effect.Effect<A, E | SessionNotActive>,
    ): Effect.Effect<A, E | SessionNotActive> =>
      Ref.get(sessions).pipe(
        Effect.flatMap((current) => {
          const session = current.get(ref.sessionId);
          return session ? use(session) : absent;
        }),
      );

    const register = (candidate: ManagedRuntime) =>
      Ref.modify(state, (current) => {
        const existing = current.active.get(candidate.runtime.sessionId);
        if (existing) return [existing, current] as const;
        return [
          candidate,
          {
            ...current,
            active: new Map(current.active).set(candidate.runtime.sessionId, candidate),
          },
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

    const getManaged = (sessionId: string): Effect.Effect<ManagedRuntime, HarnessSessionNotFound> =>
      Ref.get(state).pipe(
        Effect.flatMap((current) => {
          const managed = current.active.get(sessionId);
          return managed
            ? Effect.succeed(managed)
            : Effect.fail(new HarnessSessionNotFound({ sessionId }));
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
            onCrash: closeInstance(managed.runtime.sessionId),
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
          const managed = yield* register({ runtime: opened, scope: sessionScope });
          // Both the register winner and a deduped loser pass through here:
          // recording the index twice is idempotent and `runtime.start` treats
          // an already-draining ref as a no-op.
          yield* Ref.update(refs, (current) =>
            new Map(current).set(managed.runtime.sessionId, ref),
          );
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

    const close = (sessionId: string): Effect.Effect<void> =>
      Ref.get(refs).pipe(
        Effect.flatMap((current) => {
          const ref = current.get(sessionId);
          return ref === undefined ? Effect.void : dropSession(ref);
        }),
        Effect.andThen(closeInstance(sessionId)),
        Effect.andThen(
          Ref.update(refs, (current) => {
            const next = new Map(current);
            next.delete(sessionId);
            return next;
          }),
        ),
      );

    const ensure = (
      input: ResumeManagedSessionInput,
      ref: SessionRef,
    ): Effect.Effect<void, ResumeSessionError> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const candidate = yield* Deferred.make<ManagedRuntime, ResumeSessionError>();
          const decision = yield* Ref.modify<ManagerState, EnsureDecision>(state, (current) => {
            const closing = current.closing.get(input.sessionId);
            if (closing) return [{ _tag: "WaitForClose", deferred: closing }, current];
            const active = current.active.get(input.sessionId);
            if (active) return [{ _tag: "Active", managed: active }, current];
            const inFlight = current.inFlight.get(input.sessionId);
            if (inFlight) return [{ _tag: "Wait", deferred: inFlight }, current];
            return [
              { _tag: "Start", deferred: candidate },
              {
                ...current,
                inFlight: new Map(current.inFlight).set(input.sessionId, candidate),
              },
            ];
          });
          if (decision._tag === "Active") {
            // Already open, but a crash-replaced projection may need reviving —
            // start is a no-op on a live one.
            yield* Ref.update(refs, (current) => new Map(current).set(input.sessionId, ref));
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
                    if (current.inFlight.get(input.sessionId) !== decision.deferred) return current;
                    const inFlight = new Map(current.inFlight);
                    inFlight.delete(input.sessionId);
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
      get: (sessionId) => getManaged(sessionId).pipe(Effect.map((managed) => managed.runtime)),
      close,
      status: (ref) => withSession(ref, (session) => session.status, notActive(ref)),
      emit: (ref, body) => withSession(ref, (session) => session.emit(body), notActive(ref)),
      snapshot: (ref) => withSession(ref, (session) => session.snapshot, notActive(ref)),
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
