import type { AgentRequest, AgentResponse } from "@vibest/harness";
import { buildUiRequest, declineUiResponse, mapUiResponse } from "@vibest/harness/pi";
import { createPiTransform } from "@vibest/harness/pi";
import type { PiUIMessageChunk } from "@vibest/harness/pi";
import type { RpcExtensionUIResponse, RpcSessionState } from "@vibest/harness/pi/protocol";
import { Deferred, Effect, Exit, Queue, Ref, Scope, Stream } from "effect";
import type * as Cause from "effect/Cause";
import type * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { v7 as uuid } from "uuid";

import {
  AgentOperationError,
  AgentRequestUnavailable,
  PiTransportError,
  SessionNotFound,
  TurnAlreadyRunning,
} from "../errors";
import { drainQueue, streamFromQueueOne } from "../queue-stream";
import { makePiTransport, type PiTransport, type PiTransportFailure } from "./transport";

// Pi facade: one `pi --mode rpc` child per session (pi's RPC mode hosts a
// single session), unlike codex's shared app-server with thread demuxing.
// Crash isolation therefore comes for free — a dead child only takes down its
// own session — and there is no transport-generation bookkeeping.

const SESSION_QUEUE_CAPACITY = 1024;
const HANDSHAKE_TIMEOUT = "30 seconds";

type PendingRequest = {
  readonly deferred: Deferred.Deferred<unknown>;
  readonly declineValue: unknown;
  readonly settle: (response: AgentResponse) => unknown;
};

type PiTurnState =
  | { readonly _tag: "Idle" }
  | {
      readonly _tag: "Active";
      readonly turnId: string;
      readonly ended: Deferred.Deferred<void>;
      readonly abandoned: boolean;
    }
  | {
      readonly _tag: "Finishing";
      readonly turnId: string;
      readonly ended: Deferred.Deferred<void>;
    };

type FinishTransition = {
  readonly deliver: boolean;
  readonly ended: Deferred.Deferred<void> | undefined;
};

type TurnDecision =
  | { readonly _tag: "Start"; readonly turnId: string; readonly ended: Deferred.Deferred<void> }
  | { readonly _tag: "Steer"; readonly turn: Extract<PiTurnState, { _tag: "Active" }> }
  | { readonly _tag: "Wait"; readonly ended: Deferred.Deferred<void> };

export type PiSessionFailure = PiTransportFailure | AgentOperationError;

type SessionState = {
  readonly sessionId: string;
  readonly scope: Scope.Closeable;
  readonly transport: PiTransport;
  readonly termination: Deferred.Deferred<never, PiSessionFailure>;
  readonly chunks: Queue.Queue<PiUIMessageChunk, Cause.Done | AgentOperationError>;
  readonly requests: Queue.Queue<AgentRequest, Cause.Done>;
  readonly pending: Ref.Ref<ReadonlyMap<string, PendingRequest>>;
  readonly turnState: Ref.Ref<PiTurnState>;
  readonly transform: ReturnType<typeof createPiTransform>;
};

export interface PiAgentOptions {
  readonly executablePath?: string;
  readonly args?: ReadonlyArray<string>;
}

export interface PiAgentDependencies<R> {
  readonly makeTransport: (config: {
    readonly sessionId: string;
    readonly cwd?: string;
  }) => Effect.Effect<PiTransport, PiTransportError, R | Scope.Scope>;
}

export interface PiAgent {
  readonly session: {
    readonly create: (config: {
      readonly cwd: string;
    }) => Effect.Effect<{ readonly sessionId: string }, PiTransportFailure>;
    readonly resume: (config: {
      readonly sessionId: string;
      readonly cwd?: string;
    }) => Effect.Effect<{ readonly sessionId: string }, PiTransportFailure>;
    readonly prompt: (input: {
      readonly sessionId: string;
      readonly text: string;
    }) => Effect.Effect<
      {
        readonly turnId: string;
        readonly started: boolean;
        readonly output: Stream.Stream<PiUIMessageChunk, AgentOperationError>;
      },
      SessionNotFound | PiTransportFailure | AgentOperationError | TurnAlreadyRunning
    >;
    readonly requestPermission: (sessionId: string) => Stream.Stream<AgentRequest, SessionNotFound>;
    readonly awaitTermination: (
      sessionId: string,
    ) => Effect.Effect<never, SessionNotFound | PiSessionFailure>;
    readonly respondPermission: (
      sessionId: string,
      requestId: string,
      response: AgentResponse,
    ) => Effect.Effect<boolean, SessionNotFound | AgentRequestUnavailable>;
    readonly interrupt: (sessionId: string) => Effect.Effect<void, SessionNotFound>;
    readonly abort: (sessionId: string) => Effect.Effect<void, SessionNotFound>;
  };
}

/** @internal */
export const makePiAgentWithDependencies = <R>(
  dependencies: PiAgentDependencies<R>,
): Effect.Effect<PiAgent, never, R | Scope.Scope> =>
  Effect.gen(function* () {
    const ownerScope = yield* Scope.Scope;
    const buildContext = yield* Effect.context<R>();
    const sessions = yield* Ref.make(new Map<string, SessionState>());

    const getSession = (sessionId: string): Effect.Effect<SessionState, SessionNotFound> =>
      Ref.get(sessions).pipe(
        Effect.flatMap((current) => {
          const session = current.get(sessionId);
          return session
            ? Effect.succeed(session)
            : Effect.fail(new SessionNotFound({ sessionId }));
        }),
      );

    /** Remove the session from the registry; false when another path got there first. */
    const unregister = (session: SessionState) =>
      Ref.modify(sessions, (current) => {
        if (current.get(session.sessionId) !== session) return [false, current] as const;
        const next = new Map(current);
        next.delete(session.sessionId);
        return [true, next] as const;
      });

    const settlePending = (session: SessionState) =>
      Ref.getAndSet(session.pending, new Map()).pipe(
        Effect.flatMap((pending) =>
          Effect.forEach(
            pending.values(),
            (request) => Deferred.succeed(request.deferred, request.declineValue),
            { discard: true },
          ),
        ),
      );

    const completeTurn = (session: SessionState) =>
      Ref.getAndSet(session.turnState, { _tag: "Idle" }).pipe(
        Effect.flatMap((turn) =>
          turn._tag === "Idle"
            ? Effect.void
            : Deferred.succeed(turn.ended, undefined).pipe(Effect.asVoid),
        ),
      );

    const overflowError = (session: SessionState) =>
      new AgentOperationError({
        sessionId: session.sessionId,
        operation: "event-queue-overflow",
        cause: new Error("Pi session event queue overflowed"),
      });

    const closeScope = (session: SessionState) =>
      Effect.forkIn(Scope.close(session.scope, Exit.void), ownerScope).pipe(Effect.asVoid);

    const evictOverflowedSession = (session: SessionState) => {
      const error = overflowError(session);
      return unregister(session).pipe(
        Effect.andThen(Deferred.fail(session.termination, error)),
        Effect.andThen(settlePending(session)),
        Effect.andThen(completeTurn(session)),
        Effect.andThen(Queue.end(session.requests)),
        Effect.andThen(Queue.fail(session.chunks, error)),
        Effect.andThen(closeScope(session)),
        Effect.asVoid,
      );
    };

    const crashSession = (session: SessionState, failure: PiSessionFailure) =>
      unregister(session).pipe(
        Effect.flatMap((removed) => {
          if (!removed) return Effect.void;
          return Deferred.fail(session.termination, failure).pipe(
            Effect.andThen(settlePending(session)),
            Effect.andThen(completeTurn(session)),
            Effect.andThen(Queue.end(session.requests)),
            Effect.andThen(
              Queue.offer(session.chunks, { type: "error", errorText: failure.message }),
            ),
            Effect.flatMap((accepted) =>
              accepted
                ? Queue.end(session.chunks).pipe(Effect.asVoid)
                : Queue.fail(session.chunks, overflowError(session)).pipe(Effect.asVoid),
            ),
            Effect.andThen(closeScope(session)),
          );
        }),
      );

    /** Crash cleanup runs outside the session scope — it closes that scope. */
    const reportCrash = (session: SessionState, failure: PiSessionFailure) =>
      Effect.forkIn(crashSession(session, failure), ownerScope).pipe(Effect.asVoid);

    const routeEvent = (
      session: SessionState,
      event: Parameters<SessionState["transform"]>[0],
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        for (const chunk of session.transform(event)) {
          if (chunk.type === "finish") {
            const transition = yield* Ref.modify<PiTurnState, FinishTransition>(
              session.turnState,
              (current) => {
                if (current._tag !== "Active") {
                  return [{ deliver: false, ended: undefined }, current] as const;
                }
                return current.abandoned
                  ? ([{ deliver: false, ended: current.ended }, { _tag: "Idle" } as const] as const)
                  : ([
                      { deliver: true, ended: undefined },
                      {
                        _tag: "Finishing",
                        turnId: current.turnId,
                        ended: current.ended,
                      } as const,
                    ] as const);
              },
            );
            if (transition.ended) yield* Deferred.succeed(transition.ended, undefined);
            if (!transition.deliver) continue;
          }

          const accepted = yield* Queue.offer(session.chunks, chunk);
          if (!accepted) {
            yield* evictOverflowedSession(session);
            return;
          }
        }
      });

    const awaitAgentResponse = (
      session: SessionState,
      request: AgentRequest,
      settle: (response: AgentResponse) => unknown,
      declineValue: unknown,
    ) =>
      Effect.gen(function* () {
        const deferred = yield* Deferred.make<unknown>();
        yield* Ref.update(session.pending, (current) =>
          new Map(current).set(request.id, { deferred, settle, declineValue }),
        );
        const accepted = yield* Queue.offer(session.requests, request);
        if (!accepted) {
          yield* Ref.update(session.pending, (current) => {
            const next = new Map(current);
            next.delete(request.id);
            return next;
          });
          return declineValue;
        }
        return yield* Deferred.await(deferred).pipe(
          Effect.onInterrupt(() =>
            Ref.update(session.pending, (current) => {
              const next = new Map(current);
              next.delete(request.id);
              return next;
            }),
          ),
        );
      });

    const handleUiRequest = (
      session: SessionState,
      request: Parameters<typeof buildUiRequest>[0],
    ): Effect.Effect<void> =>
      awaitAgentResponse(
        session,
        buildUiRequest(request),
        (response) => mapUiResponse(request, response),
        declineUiResponse(request),
      ).pipe(
        Effect.flatMap((result) =>
          session.transport
            .respondUi(result as RpcExtensionUIResponse)
            .pipe(Effect.catch(() => Effect.void)),
        ),
      );

    const openSession = (
      sessionId: string,
      cwd?: string,
    ): Effect.Effect<{ readonly sessionId: string }, PiTransportFailure> =>
      Effect.gen(function* () {
        const scope = yield* Scope.fork(ownerScope, "sequential");
        return yield* Effect.gen(function* () {
          const transport = yield* dependencies
            .makeTransport({ sessionId, ...(cwd ? { cwd } : {}) })
            .pipe(Effect.provideService(Scope.Scope, scope), Effect.provideContext(buildContext));

          // Readiness handshake: pi's CLI front-end resolves the session (and
          // may exit with a human-readable error) before the RPC loop starts.
          yield* transport.command<RpcSessionState>({ type: "get_state" }).pipe(
            Effect.timeoutOrElse({
              duration: HANDSHAKE_TIMEOUT,
              orElse: () =>
                Effect.fail(
                  new PiTransportError({
                    operation: "handshake-timeout",
                    cause: new Error("Pi RPC get_state handshake timed out"),
                  }),
                ),
            }),
          );

          const session: SessionState = {
            sessionId,
            scope,
            transport,
            termination: yield* Deferred.make<never, PiSessionFailure>(),
            chunks: yield* Queue.dropping<PiUIMessageChunk, Cause.Done | AgentOperationError>(
              SESSION_QUEUE_CAPACITY,
            ),
            requests: yield* Queue.bounded<AgentRequest, Cause.Done>(SESSION_QUEUE_CAPACITY),
            pending: yield* Ref.make<ReadonlyMap<string, PendingRequest>>(new Map()),
            turnState: yield* Ref.make<PiTurnState>({ _tag: "Idle" }),
            transform: createPiTransform(sessionId),
          };
          yield* Ref.update(sessions, (current) => new Map(current).set(sessionId, session));

          yield* Stream.runForEach(transport.events, (event) => routeEvent(session, event)).pipe(
            Effect.catch((error) => reportCrash(session, error)),
            Effect.forkIn(scope),
          );
          yield* Stream.runForEach(transport.uiRequests, (request) =>
            Effect.forkIn(handleUiRequest(session, request), scope).pipe(Effect.asVoid),
          ).pipe(
            Effect.catch((error) => reportCrash(session, error)),
            Effect.forkIn(scope),
          );
          yield* transport.awaitTermination.pipe(
            Effect.catch((error) => reportCrash(session, error)),
            Effect.forkIn(scope),
          );

          return { sessionId };
        }).pipe(
          Effect.mapError((error) =>
            error instanceof PiTransportError ||
            error instanceof AgentOperationError ||
            (typeof error === "object" && error !== null && "_tag" in error)
              ? (error as PiTransportFailure)
              : new PiTransportError({ operation: "open-session", cause: error }),
          ),
          Effect.onError(() => Scope.close(scope, Exit.void)),
        );
      });

    const interrupt = (sessionId: string): Effect.Effect<void, SessionNotFound> =>
      Effect.gen(function* () {
        const session = yield* getSession(sessionId);
        const turn = yield* Ref.get(session.turnState);
        if (turn._tag !== "Active") return;
        yield* session.transport.command({ type: "abort" }).pipe(Effect.catch(() => Effect.void));
      });

    const abort = (sessionId: string): Effect.Effect<void, SessionNotFound> =>
      getSession(sessionId).pipe(
        Effect.flatMap((session) =>
          unregister(session).pipe(
            Effect.andThen(settlePending(session)),
            Effect.andThen(completeTurn(session)),
            Effect.andThen(Queue.end(session.requests)),
            Effect.andThen(Queue.end(session.chunks)),
            Effect.andThen(closeScope(session)),
            Effect.asVoid,
          ),
        ),
      );

    return {
      session: {
        create: (config) => openSession(uuid(), config.cwd),
        resume: (config) => openSession(config.sessionId, config.cwd),
        prompt: (input) =>
          Effect.gen(function* () {
            const session = yield* getSession(input.sessionId);

            const prepareTurn = (): Effect.Effect<
              {
                readonly turnId: string;
                readonly started: boolean;
                readonly output: Stream.Stream<PiUIMessageChunk, AgentOperationError>;
              },
              PiTransportFailure | AgentOperationError | TurnAlreadyRunning
            > =>
              Effect.uninterruptibleMask((restore) =>
                Effect.gen(function* () {
                  const turnId = uuid();
                  const ended = yield* Deferred.make<void>();
                  const decision = yield* Ref.modify<PiTurnState, TurnDecision>(
                    session.turnState,
                    (current) => {
                      switch (current._tag) {
                        case "Idle":
                          return [
                            { _tag: "Start", turnId, ended },
                            { _tag: "Active", turnId, ended, abandoned: false },
                          ];
                        case "Active":
                          return [{ _tag: "Steer", turn: current }, current];
                        case "Finishing":
                          return [{ _tag: "Wait", ended: current.ended }, current];
                      }
                    },
                  );

                  if (decision._tag === "Wait") {
                    yield* restore(Deferred.await(decision.ended)).pipe(
                      Effect.timeoutOrElse({
                        duration: "2 seconds",
                        orElse: () =>
                          Effect.fail(
                            new AgentOperationError({
                              sessionId: input.sessionId,
                              operation: "wait-for-finish-consumption",
                              cause: new Error("Timed out waiting for the previous Pi stream"),
                            }),
                          ),
                      }),
                    );
                    return yield* Effect.suspend(prepareTurn);
                  }
                  if (decision._tag === "Steer") {
                    const steered = yield* restore(
                      session.transport.command({ type: "steer", message: input.text }),
                    ).pipe(
                      Effect.as(true),
                      Effect.catch(() => Effect.succeed(false)),
                    );
                    if (steered) {
                      return {
                        turnId: decision.turn.turnId,
                        started: false,
                        output: Stream.empty,
                      };
                    }
                    yield* restore(Deferred.await(decision.turn.ended)).pipe(
                      Effect.timeoutOrElse({
                        duration: "2 seconds",
                        orElse: () =>
                          Effect.fail(
                            new AgentOperationError({
                              sessionId: input.sessionId,
                              operation: "wait-for-stale-turn",
                              cause: new Error("Timed out waiting for the previous Pi turn"),
                            }),
                          ),
                      }),
                    );
                    return yield* Effect.suspend(prepareTurn);
                  }

                  yield* drainQueue(session.chunks);
                  yield* session.transport
                    .command({ type: "prompt", message: input.text })
                    .pipe(
                      Effect.tapError(() =>
                        Ref.update(session.turnState, (current) =>
                          current._tag !== "Idle" && current.turnId === turnId
                            ? ({ _tag: "Idle" } as const)
                            : current,
                        ).pipe(Effect.andThen(Deferred.succeed(ended, undefined))),
                      ),
                    );

                  const finishConsumed = Ref.modify(session.turnState, (current) => {
                    if (current._tag !== "Idle" && current.turnId === turnId) {
                      return [current.ended, { _tag: "Idle" } as const] as const;
                    }
                    return [undefined, current] as const;
                  }).pipe(
                    Effect.flatMap((pendingEnd) =>
                      pendingEnd
                        ? Deferred.succeed(pendingEnd, undefined).pipe(Effect.asVoid)
                        : Effect.void,
                    ),
                  );

                  const abandonTurn = Ref.modify(session.turnState, (current) => {
                    if (current._tag === "Idle" || current.turnId !== turnId) {
                      return [undefined, current] as const;
                    }
                    if (current._tag === "Finishing") {
                      return [current.ended, { _tag: "Idle" } as const] as const;
                    }
                    return [undefined, { ...current, abandoned: true } as const] as const;
                  }).pipe(
                    Effect.flatMap((pendingEnd) =>
                      pendingEnd
                        ? Deferred.succeed(pendingEnd, undefined).pipe(Effect.asVoid)
                        : Effect.void,
                    ),
                  );

                  return {
                    turnId,
                    started: true,
                    output: streamFromQueueOne(session.chunks).pipe(
                      Stream.tap((chunk) =>
                        chunk.type === "finish" ? finishConsumed : Effect.void,
                      ),
                      Stream.takeUntil((chunk) => chunk.type === "finish"),
                      Stream.ensuring(abandonTurn),
                    ),
                  };
                }),
              );

            return yield* prepareTurn().pipe(
              Effect.onInterrupt(() =>
                interrupt(input.sessionId).pipe(Effect.catch(() => Effect.void)),
              ),
            );
          }),
        requestPermission: (sessionId) =>
          Stream.unwrap(
            getSession(sessionId).pipe(
              Effect.map((session) => streamFromQueueOne(session.requests)),
            ),
          ),
        awaitTermination: (sessionId) =>
          getSession(sessionId).pipe(
            Effect.flatMap((session) => Deferred.await(session.termination)),
          ),
        respondPermission: (sessionId, requestId, response) =>
          Effect.gen(function* () {
            const session = yield* getSession(sessionId);
            const pending = yield* Ref.modify(session.pending, (current) => {
              const request = current.get(requestId);
              if (!request) return [undefined, current] as const;
              const next = new Map(current);
              next.delete(requestId);
              return [request, next] as const;
            });
            if (!pending) {
              return yield* new AgentRequestUnavailable({ sessionId, requestId });
            }
            yield* Deferred.succeed(pending.deferred, pending.settle(response));
            return true;
          }),
        interrupt,
        abort,
      },
    } satisfies PiAgent;
  });

export const makePiAgent = (
  options: PiAgentOptions = {},
): Effect.Effect<PiAgent, never, ChildProcessSpawner.ChildProcessSpawner | Scope.Scope> =>
  makePiAgentWithDependencies({
    makeTransport: (config) =>
      makePiTransport({
        ...(options.executablePath ? { executablePath: options.executablePath } : {}),
        ...(options.args ? { args: options.args } : {}),
        sessionId: config.sessionId,
        ...(config.cwd ? { cwd: config.cwd } : {}),
      }),
  });
