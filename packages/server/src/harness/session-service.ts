import type { PermissionMode, ReasoningEffort } from "@vibest/contract";
import type { AgentResponse, HarnessAgentId } from "@vibest/contract";
import { Context, Deferred, Effect, Exit, Layer, Ref, Scope, Stream } from "effect";

import type {
  CreateSessionInput,
  HarnessAgentSession,
  PromptReceipt,
  SessionCapabilities,
  SessionInfoResult,
  UserInput,
} from "./adapter";
import {
  AgentOpenError,
  AgentOperationError,
  AgentRequestUnavailable,
  AgentUnavailable,
  CapabilityUnsupported,
  type CreateSessionError,
  type HarnessAgentNotFound,
  PermissionModeUnsupported,
  type ResumeSessionError,
  SessionClosed,
  SessionNotFound,
  SessionNotResumable,
  TurnAlreadyRunning,
} from "./errors";
import type { SessionEnvelopeDraft } from "./events/framework";
import type { HarnessAgentRegistryShape } from "./registry";
import { HarnessAgentRegistry } from "./registry";
import type { CreateManagedSessionResult, ResumeManagedSessionInput } from "./session-io";

/**
 * Owns agent-native session lifecycle only. The server SessionRuntime owns the
 * projection, per-session `seq`, snapshot/status, and subscriber fan-out; this
 * service just opens/resumes/closes native sessions and hands the server the
 * raw per-session {@link SessionEnvelopeDraft} stream via {@link events}.
 */

type ManagedSession = {
  readonly session: HarnessAgentSession;
  readonly scope: Scope.Closeable;
};

type ServiceState = {
  readonly active: ReadonlyMap<string, ManagedSession>;
  readonly inFlight: ReadonlyMap<string, Deferred.Deferred<ManagedSession, ResumeSessionError>>;
  readonly closing: ReadonlyMap<string, Deferred.Deferred<void>>;
};

type ResumeDecision =
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

export type CreateSessionResult = CreateManagedSessionResult;
export type { ResumeManagedSessionInput } from "./session-io";

export type HarnessAgentSessionServiceShape = {
  readonly create: (
    harnessAgentId: HarnessAgentId,
    input: CreateSessionInput,
  ) => Effect.Effect<CreateSessionResult, CreateSessionError>;
  readonly resume: (input: ResumeManagedSessionInput) => Effect.Effect<void, ResumeSessionError>;
  readonly prompt: (
    sessionId: string,
    input: UserInput,
  ) => Effect.Effect<
    PromptReceipt,
    SessionNotFound | SessionClosed | TurnAlreadyRunning | AgentOperationError
  >;
  readonly interrupt: (
    sessionId: string,
  ) => Effect.Effect<void, SessionNotFound | SessionClosed | AgentOperationError>;
  readonly setModel: (
    sessionId: string,
    model: string,
  ) => Effect.Effect<void, SessionNotFound | SessionClosed | AgentOperationError>;
  readonly setReasoningEffort: (
    sessionId: string,
    reasoningEffort: ReasoningEffort,
  ) => Effect.Effect<void, SessionNotFound | SessionClosed | AgentOperationError>;
  readonly setPermissionMode: (
    sessionId: string,
    mode: PermissionMode,
  ) => Effect.Effect<
    void,
    SessionNotFound | PermissionModeUnsupported | SessionClosed | AgentOperationError
  >;
  readonly respondToAgentRequest: (
    sessionId: string,
    requestId: string,
    response: AgentResponse,
  ) => Effect.Effect<void, SessionNotFound | AgentRequestUnavailable | AgentOperationError>;
  readonly getCapabilities: (
    sessionId: string,
  ) => Effect.Effect<
    SessionCapabilities,
    SessionNotFound | CapabilityUnsupported | AgentOperationError
  >;
  /**
   * Look up display info (title, recency) for a persisted session by its native
   * id, without opening it — used at list time. Never requires an active
   * session; goes straight to the adapter via the registry.
   */
  readonly getSessionInfo: (
    harnessAgentId: HarnessAgentId,
    harnessSessionId: string,
    cwd?: string,
  ) => Effect.Effect<SessionInfoResult, HarnessAgentNotFound | AgentOperationError>;
  /**
   * The raw per-session event stream, drained by the server SessionRuntime. The
   * harness never numbers or projects it; drafts are native-`sessionId`-keyed.
   */
  readonly events: (
    sessionId: string,
  ) => Effect.Effect<Stream.Stream<SessionEnvelopeDraft, AgentOperationError>, SessionNotFound>;
  readonly close: (sessionId: string) => Effect.Effect<void>;
};

export class HarnessAgentSessionService extends Context.Service<
  HarnessAgentSessionService,
  HarnessAgentSessionServiceShape
>()("HarnessAgentSessionService") {}

export const makeHarnessAgentSessionService = (
  registry: HarnessAgentRegistryShape,
): Effect.Effect<HarnessAgentSessionServiceShape, never, Scope.Scope> =>
  Effect.gen(function* () {
    const ownerScope = yield* Scope.Scope;
    const state = yield* Ref.make<ServiceState>({
      active: new Map(),
      inFlight: new Map(),
      closing: new Map(),
    });

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
          ),
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
          return yield* register({ session, scope: sessionScope });
        }).pipe(Effect.onError(() => Scope.close(sessionScope, Exit.void)));
      });

    const getManaged = (sessionId: string): Effect.Effect<ManagedSession, SessionNotFound> =>
      Ref.get(state).pipe(
        Effect.flatMap((current) => {
          const managed = current.active.get(sessionId);
          return managed
            ? Effect.succeed(managed)
            : Effect.fail(new SessionNotFound({ sessionId }));
        }),
      );

    const closeManaged = (managed: ManagedSession) =>
      managed.session.close.pipe(
        Effect.ensuring(Scope.close(managed.scope, Exit.void)),
        Effect.asVoid,
      );

    const close = (sessionId: string): Effect.Effect<void> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const candidate = yield* Deferred.make<void>();
          const decision = yield* Ref.modify<ServiceState, CloseDecision>(state, (current) => {
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

    const resume = (input: ResumeManagedSessionInput): Effect.Effect<void, ResumeSessionError> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const candidate = yield* Deferred.make<ManagedSession, ResumeSessionError>();
          const decision = yield* Ref.modify<ServiceState, ResumeDecision>(state, (current) => {
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
          if (decision._tag === "Active") return;
          if (decision._tag === "WaitForClose") {
            yield* restore(Deferred.await(decision.deferred));
            return yield* resume(input);
          }
          if (decision._tag === "Start") {
            yield* Effect.forkIn(
              build({ _tag: "Resume", input }).pipe(
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
          yield* restore(Deferred.await(decision.deferred));
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

    // The permission mode is our closed vocabulary, so membership in the
    // harness's declared subset is checked here — the boundary between the
    // wire and the adapters — and rejected loudly. Opaque values (model) get
    // no such check: their lists go stale legitimately, so adapters treat
    // misses as best-effort instead.
    const checkPermissionMode = (
      harnessAgentId: HarnessAgentId,
      mode: PermissionMode | undefined,
    ) =>
      mode === undefined
        ? Effect.void
        : registry
            .get(harnessAgentId)
            .pipe(
              Effect.flatMap((adapter) =>
                adapter.permissionModes.includes(mode)
                  ? Effect.void
                  : Effect.fail(new PermissionModeUnsupported({ harnessAgentId, mode })),
              ),
            );

    return {
      create: (harnessAgentId, input) =>
        checkPermissionMode(harnessAgentId, input.permissionMode).pipe(
          Effect.andThen(build({ _tag: "Open", harnessAgentId, input })),
          Effect.map((managed) => ({
            sessionId: managed.session.sessionId,
            harnessAgentId: managed.session.harnessAgentId,
          })),
          Effect.mapError((error) =>
            error instanceof SessionNotResumable
              ? new AgentOpenError({ harnessAgentId, cause: error })
              : error,
          ),
        ),
      resume,
      prompt: (sessionId, input) =>
        getManaged(sessionId).pipe(Effect.flatMap((managed) => managed.session.prompt(input))),
      interrupt: (sessionId) =>
        getManaged(sessionId).pipe(Effect.flatMap((managed) => managed.session.interrupt)),
      setModel: (sessionId, model) =>
        getManaged(sessionId).pipe(Effect.flatMap((managed) => managed.session.setModel(model))),
      setReasoningEffort: (sessionId, reasoningEffort) =>
        getManaged(sessionId).pipe(
          Effect.flatMap((managed) => managed.session.setReasoningEffort(reasoningEffort)),
        ),
      setPermissionMode: (sessionId, mode) =>
        getManaged(sessionId).pipe(
          Effect.flatMap((managed) =>
            // The session is open, so its adapter is registered by construction.
            checkPermissionMode(managed.session.harnessAgentId, mode).pipe(
              Effect.catchTag("HarnessAgentNotFound", (cause) => Effect.die(cause)),
              Effect.andThen(managed.session.setPermissionMode(mode)),
            ),
          ),
        ),
      respondToAgentRequest: (sessionId, requestId, response) =>
        getManaged(sessionId).pipe(
          Effect.flatMap((managed) => managed.session.respondToAgentRequest(requestId, response)),
        ),
      getCapabilities: (sessionId) =>
        getManaged(sessionId).pipe(Effect.flatMap((managed) => managed.session.getCapabilities)),
      getSessionInfo: (harnessAgentId, harnessSessionId, cwd) =>
        registry
          .get(harnessAgentId)
          .pipe(Effect.flatMap((adapter) => adapter.getSessionInfo(harnessSessionId, cwd))),
      events: (sessionId) =>
        getManaged(sessionId).pipe(Effect.map((managed) => managed.session.events)),
      close,
    } satisfies HarnessAgentSessionServiceShape;
  });

export const HarnessAgentSessionServiceLayer = Layer.effect(
  HarnessAgentSessionService,
  Effect.gen(function* () {
    const registry = yield* HarnessAgentRegistry;
    return yield* makeHarnessAgentSessionService(registry);
  }),
);
