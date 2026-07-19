import { isSessionEvent, type SessionEnvelope, type SessionEnvelopeDraft } from "@vibest/harness";
import type { HarnessAgentId } from "@vibest/harness";
import type { AgentRequest, AgentResponse } from "@vibest/harness";
import type { SessionSnapshot, SessionStatus } from "@vibest/harness";
import { Context, Deferred, Effect, Exit, Fiber, Layer, Ref, Scope, Stream } from "effect";
import { v7 as uuid } from "uuid";

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
  type ResumeSessionError,
  SessionClosed,
  SessionNotFound,
  SessionNotResumable,
  TurnAlreadyRunning,
} from "./errors";
import type { HarnessAgentRegistryShape } from "./registry";
import { HarnessAgentRegistry } from "./registry";
import type { CreateManagedSessionResult, ResumeManagedSessionInput } from "./rpc";
import { SessionEventPublisher, type SessionEventPublisherShape } from "./session-event-publisher";

const PUMP_DRAIN_TIMEOUT = "2 seconds";
const REPLAY_CAPACITY = 2048;

type Projection = {
  readonly cursor: number;
  readonly status: SessionStatus;
  readonly pendingRequests: ReadonlyMap<string, AgentRequest>;
  readonly activeTurn: {
    readonly turnId: string;
    readonly chunks: ReadonlyArray<SessionEnvelope>;
    readonly complete: boolean;
  } | null;
  readonly degraded: boolean;
};

type ManagedSession = {
  /** vibest-internal id — the `active`/`inFlight`/`closing` map key and the id
   *  every envelope and cold operation uses. */
  readonly sessionId: string;
  /** Backend id (`session.sessionId`) — what the adapter needs to resume. */
  readonly harnessSessionId: string;
  readonly session: HarnessAgentSession;
  readonly scope: Scope.Closeable;
  readonly pump: Fiber.Fiber<void>;
  readonly pumpDone: Deferred.Deferred<void>;
  readonly projection: Ref.Ref<Projection>;
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
export type { ResumeManagedSessionInput } from "./rpc";

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
  readonly getStatus: (sessionId: string) => Effect.Effect<SessionStatus, SessionNotFound>;
  readonly getSnapshot: (sessionId: string) => Effect.Effect<SessionSnapshot, SessionNotFound>;
  readonly close: (sessionId: string) => Effect.Effect<void>;
  /** Look up live backend display info for a persisted session (cold — the
   *  session need not be active). Delegates to the owning adapter. */
  readonly getSessionInfo: (
    harnessAgentId: HarnessAgentId,
    harnessSessionId: string,
    workspacePath?: string,
  ) => Effect.Effect<SessionInfoResult, HarnessAgentNotFound | AgentOperationError>;
};

export class HarnessAgentSessionService extends Context.Service<
  HarnessAgentSessionService,
  HarnessAgentSessionServiceShape
>()("HarnessAgentSessionService") {}

const initialProjection = (): Projection => ({
  cursor: 0,
  status: {
    status: "running",
    isBusy: false,
    needsAttention: false,
  },
  pendingRequests: new Map(),
  activeTurn: null,
  degraded: false,
});

const stampEnvelope = (draft: SessionEnvelopeDraft, seq: number): SessionEnvelope =>
  ({ ...draft, seq }) as SessionEnvelope;

const updateProjection = (current: Projection, envelope: SessionEnvelope): Projection => {
  const body = envelope.body;
  if (!isSessionEvent(body)) {
    if (!current.activeTurn) return { ...current, cursor: envelope.seq };
    if (current.activeTurn.chunks.length >= REPLAY_CAPACITY) {
      return { ...current, cursor: envelope.seq, degraded: true };
    }
    return {
      ...current,
      cursor: envelope.seq,
      activeTurn: {
        ...current.activeTurn,
        chunks: [...current.activeTurn.chunks, envelope],
      },
    };
  }

  switch (body.type) {
    case "session.turn.started":
      return {
        ...current,
        cursor: envelope.seq,
        status: { ...current.status, status: "running", isBusy: true },
        activeTurn: { turnId: body.turnId, chunks: [], complete: false },
        degraded: false,
      };
    case "session.turn.ended":
      return {
        ...current,
        cursor: envelope.seq,
        status: { ...current.status, isBusy: false },
        activeTurn:
          current.activeTurn?.turnId === body.turnId
            ? { ...current.activeTurn, complete: true }
            : current.activeTurn,
      };
    case "session.request.asked":
      return {
        ...current,
        cursor: envelope.seq,
        status: { ...current.status, needsAttention: true },
        pendingRequests: new Map(current.pendingRequests).set(body.request.id, body.request),
      };
    case "session.request.replied":
    case "session.request.rejected": {
      const pendingRequests = new Map(current.pendingRequests);
      pendingRequests.delete(body.requestId);
      return {
        ...current,
        cursor: envelope.seq,
        status: { ...current.status, needsAttention: pendingRequests.size > 0 },
        pendingRequests,
      };
    }
    case "session.crashed":
      return {
        ...current,
        cursor: envelope.seq,
        status: { status: "crashed", isBusy: false, needsAttention: false },
        pendingRequests: new Map(),
        activeTurn: null,
      };
    default:
      return { ...current, cursor: envelope.seq };
  }
};

export const makeHarnessAgentSessionService = (
  registry: HarnessAgentRegistryShape,
  publisher: SessionEventPublisherShape,
): Effect.Effect<HarnessAgentSessionServiceShape, never, Scope.Scope> =>
  Effect.gen(function* () {
    const ownerScope = yield* Scope.Scope;
    const state = yield* Ref.make<ServiceState>({
      active: new Map(),
      inFlight: new Map(),
      closing: new Map(),
    });
    const bootId = uuid();

    const publish = (projection: Ref.Ref<Projection>, draft: SessionEnvelopeDraft) =>
      publisher
        .publish(draft)
        .pipe(
          Effect.flatMap((seq) =>
            Ref.update(projection, (current) =>
              updateProjection(current, stampEnvelope(draft, seq)),
            ),
          ),
        );

    const startManaged = (
      sessionId: string,
      session: HarnessAgentSession,
      sessionScope: Scope.Closeable,
    ): Effect.Effect<{
      readonly managed: ManagedSession;
      readonly activate: Effect.Effect<void>;
    }> =>
      Effect.gen(function* () {
        const projection = yield* Ref.make(initialProjection());
        const pumpDone = yield* Deferred.make<void>();
        const activation = yield* Deferred.make<void>();
        // The adapter stamps envelopes with its backend id; rewrite them to the
        // vibest-internal id so everything downstream (subscribers, cold ops)
        // speaks one id.
        const events = session.events.pipe(Stream.map((draft) => ({ ...draft, sessionId })));
        const pumpEffect = Deferred.await(activation).pipe(
          Effect.andThen(Stream.runForEach(events, (draft) => publish(projection, draft))),
          Effect.catch((error) =>
            publish(projection, {
              harnessAgentId: session.harnessAgentId,
              sessionId,
              body: {
                type: "session.crashed",
                sessionId,
                reason: error.message,
              },
            }),
          ),
          Effect.ensuring(
            Deferred.succeed(pumpDone, undefined).pipe(
              Effect.andThen(
                Ref.get(projection).pipe(
                  Effect.flatMap((current) =>
                    current.status.status === "crashed"
                      ? Effect.forkIn(close(sessionId), ownerScope).pipe(Effect.asVoid)
                      : Effect.void,
                  ),
                ),
              ),
            ),
          ),
        );
        const pump = yield* Effect.forkIn(pumpEffect, sessionScope);
        return {
          managed: {
            sessionId,
            harnessSessionId: session.sessionId,
            session,
            scope: sessionScope,
            pump,
            pumpDone,
            projection,
          },
          activate: Deferred.succeed(activation, undefined).pipe(Effect.asVoid),
        };
      });

    const register = (candidate: ManagedSession) =>
      Ref.modify(state, (current) => {
        const existing = current.active.get(candidate.sessionId);
        if (existing) return [existing, current] as const;
        return [
          candidate,
          {
            ...current,
            active: new Map(current.active).set(candidate.sessionId, candidate),
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
          // vibest-internal id: freshly minted on open, or the caller's own id on
          // resume. Distinct from the adapter's backend id (`session.sessionId`).
          const sessionId = mode._tag === "Open" ? uuid() : mode.input.sessionId;
          const session = yield* (
            mode._tag === "Open"
              ? adapter.open(mode.input)
              : adapter.resume({
                  // Adapters resume by backend id, distinct from our internal id.
                  sessionId: mode.input.harnessSessionId,
                  workspacePath: mode.input.workspacePath,
                })
          ).pipe(Effect.provideService(Scope.Scope, sessionScope));
          const candidate = yield* startManaged(sessionId, session, sessionScope);
          const managed = yield* register(candidate.managed);
          if (managed === candidate.managed) yield* candidate.activate;
          return managed;
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
        Effect.andThen(
          Deferred.await(managed.pumpDone).pipe(
            Effect.timeoutOrElse({
              duration: PUMP_DRAIN_TIMEOUT,
              orElse: () => Fiber.interrupt(managed.pump).pipe(Effect.asVoid),
            }),
          ),
        ),
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

    return {
      create: (harnessAgentId, input) =>
        build({ _tag: "Open", harnessAgentId, input }).pipe(
          Effect.map((managed) => ({
            sessionId: managed.sessionId,
            harnessSessionId: managed.harnessSessionId,
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
        Effect.gen(function* () {
          const managed = yield* getManaged(sessionId);
          const cursor = yield* Ref.get(managed.projection).pipe(
            Effect.map((current) => current.cursor),
          );
          const receipt = yield* managed.session.prompt(input);
          return { turnId: receipt.turnId, cursor, started: receipt.started };
        }),
      interrupt: (sessionId) =>
        getManaged(sessionId).pipe(Effect.flatMap((managed) => managed.session.interrupt)),
      respondToAgentRequest: (sessionId, requestId, response) =>
        getManaged(sessionId).pipe(
          Effect.flatMap((managed) => managed.session.respondToAgentRequest(requestId, response)),
        ),
      getCapabilities: (sessionId) =>
        getManaged(sessionId).pipe(Effect.flatMap((managed) => managed.session.getCapabilities)),
      getStatus: (sessionId) =>
        getManaged(sessionId).pipe(
          Effect.flatMap((managed) =>
            Ref.get(managed.projection).pipe(Effect.map((projection) => projection.status)),
          ),
        ),
      getSnapshot: (sessionId) =>
        getManaged(sessionId).pipe(
          Effect.flatMap((managed) =>
            Ref.get(managed.projection).pipe(
              Effect.map(
                (projection): SessionSnapshot => ({
                  history: [],
                  activeTurn: projection.activeTurn
                    ? {
                        turnId: projection.activeTurn.turnId,
                        chunks: [...projection.activeTurn.chunks],
                        complete: projection.activeTurn.complete,
                      }
                    : null,
                  pendingRequests: Array.from(projection.pendingRequests.values()),
                  cursor: projection.cursor,
                  degraded: projection.degraded,
                  bootId,
                }),
              ),
            ),
          ),
        ),
      close,
      getSessionInfo: (harnessAgentId, harnessSessionId, workspacePath) =>
        registry
          .get(harnessAgentId)
          .pipe(
            Effect.flatMap((adapter) => adapter.getSessionInfo(harnessSessionId, workspacePath)),
          ),
    } satisfies HarnessAgentSessionServiceShape;
  });

export const HarnessAgentSessionServiceLayer = Layer.effect(
  HarnessAgentSessionService,
  Effect.gen(function* () {
    const registry = yield* HarnessAgentRegistry;
    const publisher = yield* SessionEventPublisher;
    return yield* makeHarnessAgentSessionService(registry, publisher);
  }),
);
