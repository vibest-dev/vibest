import type {
  HarnessAgentId,
  SessionRef,
  SessionRuntimeSnapshot,
  SessionScopedEventBody,
  SessionStatus,
} from "@vibest/contract";
import { Context, Deferred, Effect, Exit, FileSystem, Layer, Ref, Scope, Stream } from "effect";

import { EventBus, type EventBusShape } from "../events/event-bus";
import type { CreateSessionInput, HarnessAgentSession } from "./adapter";
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
import type { ResumeManagedSessionInput } from "./session-io";
import {
  type HarnessAgentSessionRuntimeShape,
  makeHarnessAgentSessionRuntime,
  type SessionNotActive,
} from "./session-runtime";

/**
 * The sole owner of live session state: which sessions are open, which are
 * mid-open, which are closing (the instance table), and what each one is
 * currently doing (the projection, delegated to the private
 * {@link makeHarnessAgentSessionRuntime} module). It is the single caller of
 * `adapter.open` / `adapter.resume`, so per-sessionId single-flighting lives
 * here and nowhere else — adapters may assume they are never asked to open the
 * same session twice concurrently — and a built instance always has a draining
 * projection, by construction rather than by caller discipline.
 *
 * Vocabulary: lifecycle addressing (`get`/`close`) speaks the agent-native
 * session id; the {@link SessionRef} received by `open`/`ensure` is carried
 * opaquely — stamped onto projected wire events and used as the projection
 * key — never interpreted. Adapters never see it.
 */

type ManagedSession = {
  readonly session: HarnessAgentSession;
  readonly scope: Scope.Closeable;
};

type ManagerState = {
  readonly active: ReadonlyMap<string, ManagedSession>;
  readonly inFlight: ReadonlyMap<string, Deferred.Deferred<ManagedSession, ResumeSessionError>>;
  readonly closing: ReadonlyMap<string, Deferred.Deferred<void>>;
};

type EnsureDecision =
  | { readonly _tag: "Active"; readonly managed: ManagedSession }
  | { readonly _tag: "WaitForClose"; readonly deferred: Deferred.Deferred<void> }
  | {
      readonly _tag: "Start";
      readonly deferred: Deferred.Deferred<ManagedSession, ResumeSessionError>;
    }
  | {
      readonly _tag: "Wait";
      readonly deferred: Deferred.Deferred<ManagedSession, ResumeSessionError>;
    };

type CloseDecision =
  | { readonly _tag: "Done" }
  | { readonly _tag: "Wait"; readonly deferred: Deferred.Deferred<void> }
  | {
      readonly _tag: "Start";
      readonly managed: ManagedSession;
      readonly deferred: Deferred.Deferred<void>;
    }
  | {
      readonly _tag: "StartAfterBuild";
      readonly build: Deferred.Deferred<ManagedSession, ResumeSessionError>;
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
  ) => Effect.Effect<HarnessAgentSession, CreateSessionError>;
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
  readonly get: (sessionId: string) => Effect.Effect<HarnessAgentSession, HarnessSessionNotFound>;
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
    const runtime: HarnessAgentSessionRuntimeShape = yield* makeHarnessAgentSessionRuntime(bus);
    const state = yield* Ref.make<ManagerState>({
      active: new Map(),
      inFlight: new Map(),
      closing: new Map(),
    });
    // native sessionId → the ref its projection lives under. Deliberately
    // outlives a crashed instance (the projection does too); only an explicit
    // `close` clears it, so a late close can still find and stop the crashed
    // projection.
    const refs = yield* Ref.make<ReadonlyMap<string, SessionRef>>(new Map());

    const register = (candidate: ManagedSession) =>
      Ref.modify(state, (current) => {
        const existing = current.active.get(candidate.session.sessionId);
        if (existing) return [existing, current] as const;
        return [
          candidate,
          {
            ...current,
            active: new Map(current.active).set(candidate.session.sessionId, candidate),
          },
        ] as const;
      }).pipe(
        Effect.tap((registered) =>
          registered === candidate
            ? Effect.void
            : candidate.session.close.pipe(Effect.andThen(Scope.close(candidate.scope, Exit.void))),
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

    const getManaged = (sessionId: string): Effect.Effect<ManagedSession, HarnessSessionNotFound> =>
      Ref.get(state).pipe(
        Effect.flatMap((current) => {
          const managed = current.active.get(sessionId);
          return managed
            ? Effect.succeed(managed)
            : Effect.fail(new HarnessSessionNotFound({ sessionId }));
        }),
      );

    const closeManaged = (managed: ManagedSession) =>
      managed.session.close.pipe(
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

    // A crash releases the instance but keeps projection + index (see `close`).
    const startDrain = (managed: ManagedSession, ref: SessionRef) =>
      runtime.start(ref, managed.session.events.pipe(Stream.map((draft) => draft.body)), {
        onCrash: closeInstance(managed.session.sessionId),
      });

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
          const session = yield* (
            mode._tag === "Open"
              ? adapter.open(mode.input)
              : adapter.resume({
                  sessionId: mode.input.sessionId,
                  cwd: mode.input.cwd,
                })
          ).pipe(Effect.provideService(Scope.Scope, sessionScope));
          const managed = yield* register({ session, scope: sessionScope });
          // Both the register winner and a deduped loser pass through here:
          // recording the index twice is idempotent and `runtime.start` treats
          // an already-draining ref as a no-op.
          yield* Ref.update(refs, (current) =>
            new Map(current).set(managed.session.sessionId, ref),
          );
          yield* startDrain(managed, ref);
          return managed;
        }).pipe(Effect.onError(() => Scope.close(sessionScope, Exit.void)));
      });

    const close = (sessionId: string): Effect.Effect<void> =>
      Ref.get(refs).pipe(
        Effect.flatMap((current) => {
          const ref = current.get(sessionId);
          return ref === undefined ? Effect.void : runtime.stop(ref);
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
          const candidate = yield* Deferred.make<ManagedSession, ResumeSessionError>();
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
          Effect.map((managed) => managed.session),
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
      get: (sessionId) => getManaged(sessionId).pipe(Effect.map((managed) => managed.session)),
      close,
      status: (ref) => runtime.status(ref),
      emit: (ref, body) => runtime.emit(ref, body),
      snapshot: (ref) => runtime.snapshot(ref),
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
