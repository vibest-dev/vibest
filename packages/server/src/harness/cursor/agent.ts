import type { AgentRequest, AgentResponse, ReasoningEffort, TokenUsage } from "@vibest/contract";
import type { CursorUIMessageChunk } from "@vibest/contract/cursor";
import { Deferred, Effect, Exit, FileSystem, Queue, Ref, Scope, Stream } from "effect";
import type * as Cause from "effect/Cause";
import type * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { v7 as uuid } from "uuid";

import {
  AgentOperationError,
  AgentRequestUnavailable,
  CursorRpcError,
  CursorTransportError,
  HarnessSessionNotFound,
  SessionNotResumable,
  TurnAlreadyRunning,
} from "../errors";
import { drainQueue, streamFromQueueOne } from "../queue-stream";
import { cursorNotFoundMessage, resolveCursorExecutable } from "./executable";
import {
  AUTH_METHOD_ID,
  TURN_END_METHOD,
  hasCursorLogin,
  initializeParams,
  isCancelledStopReason,
  isRequestPermission,
  promptResultOf,
  sessionIdOf,
  unwrapModels,
  type ModelsListResult,
  type RpcNotification,
  type RpcServerRequest,
} from "./protocol";
import {
  buildPermissionRequest,
  cancelledPermissionResult,
  mapPermissionResponse,
} from "./request";
import { createCursorTransform } from "./transform";
import {
  makeCursorTransport,
  type CursorTransport,
  type CursorTransportFailure,
} from "./transport";

const SESSION_QUEUE_CAPACITY = 1024;
const HANDSHAKE_TIMEOUT = "30 seconds";

type PendingRequest = {
  readonly deferred: Deferred.Deferred<unknown>;
  readonly declineValue: unknown;
  readonly settle: (response: AgentResponse) => unknown;
};

type CursorTurnState =
  | { readonly _tag: "Idle" }
  | {
      readonly _tag: "Active";
      readonly turnId: string;
      readonly ended: Deferred.Deferred<void>;
    };

type TurnEnd = {
  readonly outcome: "completed" | "canceled";
  readonly usage?: TokenUsage;
};

export type CursorSessionFailure = CursorTransportFailure | AgentOperationError;

type SessionState = {
  readonly sessionId: string;
  readonly scope: Scope.Closeable;
  readonly transport: CursorTransport;
  readonly termination: Deferred.Deferred<never, CursorSessionFailure>;
  readonly chunks: Queue.Queue<CursorUIMessageChunk, Cause.Done | AgentOperationError>;
  readonly requests: Queue.Queue<AgentRequest, Cause.Done>;
  readonly pending: Ref.Ref<ReadonlyMap<string, PendingRequest>>;
  readonly turnState: Ref.Ref<CursorTurnState>;
  readonly turnEnd: Ref.Ref<TurnEnd | undefined>;
  readonly transform: ReturnType<typeof createCursorTransform>;
};

export interface CursorAgentOptions {
  readonly executablePath?: string;
  readonly args?: ReadonlyArray<string>;
}

export interface CursorAgentDependencies<R> {
  readonly makeTransport: (config: {
    readonly cwd?: string;
  }) => Effect.Effect<CursorTransport, CursorTransportError, R | Scope.Scope>;
}

export interface CursorAgent {
  readonly listModels: Effect.Effect<ModelsListResult, CursorTransportFailure>;
  readonly session: {
    readonly create: (config: {
      readonly cwd: string;
    }) => Effect.Effect<{ readonly sessionId: string }, CursorTransportFailure>;
    readonly resume: (config: {
      readonly sessionId: string;
      readonly cwd: string;
    }) => Effect.Effect<
      { readonly sessionId: string },
      CursorTransportFailure | SessionNotResumable
    >;
    readonly prompt: (input: {
      readonly sessionId: string;
      readonly text: string;
    }) => Effect.Effect<
      {
        readonly turnId: string;
        readonly started: boolean;
        readonly output: Stream.Stream<CursorUIMessageChunk, AgentOperationError>;
        readonly completion: Effect.Effect<TurnEnd>;
      },
      HarnessSessionNotFound | CursorTransportFailure | AgentOperationError | TurnAlreadyRunning
    >;
    readonly setModel: (
      sessionId: string,
      model: string,
    ) => Effect.Effect<void, HarnessSessionNotFound | CursorTransportFailure>;
    readonly setReasoningEffort: (
      sessionId: string,
      effort: ReasoningEffort,
    ) => Effect.Effect<void, HarnessSessionNotFound | CursorTransportFailure>;
    readonly setPermissionMode: (
      sessionId: string,
      modeId: string,
    ) => Effect.Effect<void, HarnessSessionNotFound | CursorTransportFailure>;
    readonly requestPermission: (
      sessionId: string,
    ) => Stream.Stream<AgentRequest, HarnessSessionNotFound>;
    readonly awaitTermination: (
      sessionId: string,
    ) => Effect.Effect<never, HarnessSessionNotFound | CursorSessionFailure>;
    readonly respondPermission: (
      sessionId: string,
      requestId: string,
      response: AgentResponse,
    ) => Effect.Effect<boolean, HarnessSessionNotFound | AgentRequestUnavailable>;
    readonly interrupt: (sessionId: string) => Effect.Effect<void, HarnessSessionNotFound>;
    readonly abort: (sessionId: string) => Effect.Effect<void, HarnessSessionNotFound>;
  };
}

/** @internal */
export const makeCursorAgentWithDependencies = <R>(
  dependencies: CursorAgentDependencies<R>,
): Effect.Effect<CursorAgent, never, R | Scope.Scope> =>
  Effect.gen(function* () {
    const ownerScope = yield* Scope.Scope;
    const buildContext = yield* Effect.context<R>();
    const sessions = yield* Ref.make(new Map<string, SessionState>());

    const getSession = (sessionId: string): Effect.Effect<SessionState, HarnessSessionNotFound> =>
      Ref.get(sessions).pipe(
        Effect.flatMap((current) => {
          const session = current.get(sessionId);
          return session
            ? Effect.succeed(session)
            : Effect.fail(new HarnessSessionNotFound({ sessionId }));
        }),
      );

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
        cause: new Error("Cursor session event queue overflowed"),
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

    const crashSession = (session: SessionState, failure: CursorSessionFailure) =>
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

    const reportCrash = (session: SessionState, failure: CursorSessionFailure) =>
      Effect.forkIn(crashSession(session, failure), ownerScope).pipe(Effect.asVoid);

    const offerChunk = (session: SessionState, chunk: CursorUIMessageChunk) =>
      Queue.offer(session.chunks, chunk).pipe(
        Effect.flatMap((accepted) => (accepted ? Effect.void : evictOverflowedSession(session))),
      );

    const settleTurn = (session: SessionState, turnId: string) =>
      Ref.modify<CursorTurnState, Deferred.Deferred<void> | undefined>(
        session.turnState,
        (current) => {
          if (current._tag !== "Active" || current.turnId !== turnId) {
            return [undefined, current] as const;
          }
          return [current.ended, { _tag: "Idle" } as const] as const;
        },
      ).pipe(
        Effect.flatMap((ended) =>
          ended ? Deferred.succeed(ended, undefined).pipe(Effect.asVoid) : Effect.void,
        ),
      );

    const routeNotification = (
      session: SessionState,
      notification: RpcNotification,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        for (const chunk of session.transform.apply(notification)) {
          if (chunk.type === "finish") {
            const ended = yield* Ref.modify<CursorTurnState, Deferred.Deferred<void> | undefined>(
              session.turnState,
              (current) => {
                if (current._tag !== "Active") return [undefined, current] as const;
                return [current.ended, { _tag: "Idle" } as const] as const;
              },
            );
            if (!ended) continue;
            yield* Deferred.succeed(ended, undefined);
          }
          yield* offerChunk(session, chunk);
        }
      });

    const handleServerRequest = (
      session: SessionState,
      request: RpcServerRequest,
    ): Effect.Effect<void> => {
      if (!isRequestPermission(request)) {
        return session.transport
          .respondError(request.id, {
            code: -32601,
            message: `Unsupported ACP request '${request.method}'`,
          })
          .pipe(Effect.catch(() => Effect.void));
      }
      const agentRequest = buildPermissionRequest(request);
      return Effect.gen(function* () {
        const deferred = yield* Deferred.make<unknown>();
        yield* Ref.update(session.pending, (current) =>
          new Map(current).set(agentRequest.id, {
            deferred,
            settle: mapPermissionResponse,
            declineValue: cancelledPermissionResult,
          }),
        );
        const accepted = yield* Queue.offer(session.requests, agentRequest);
        if (!accepted) {
          yield* Ref.update(session.pending, (current) => {
            const next = new Map(current);
            next.delete(agentRequest.id);
            return next;
          });
          yield* session.transport
            .respond(request.id, cancelledPermissionResult)
            .pipe(Effect.catch(() => Effect.void));
          return;
        }
        const result = yield* Deferred.await(deferred).pipe(
          Effect.onInterrupt(() =>
            Ref.update(session.pending, (current) => {
              const next = new Map(current);
              next.delete(agentRequest.id);
              return next;
            }),
          ),
        );
        yield* session.transport.respond(request.id, result).pipe(Effect.catch(() => Effect.void));
      });
    };

    const handshake = (transport: CursorTransport): Effect.Effect<void, CursorTransportFailure> =>
      transport.request("initialize", initializeParams).pipe(
        Effect.timeoutOrElse({
          duration: HANDSHAKE_TIMEOUT,
          orElse: () =>
            Effect.fail(
              new CursorTransportError({
                operation: "handshake-timeout",
                cause: new Error("Cursor ACP initialize timed out"),
              }),
            ),
        }),
        Effect.flatMap((result) =>
          hasCursorLogin(result)
            ? transport.request("authenticate", { methodId: AUTH_METHOD_ID }).pipe(Effect.asVoid)
            : Effect.void,
        ),
      );

    const registerSession = (
      sessionId: string,
      transport: CursorTransport,
      scope: Scope.Closeable,
    ): Effect.Effect<SessionState> =>
      Effect.gen(function* () {
        const session: SessionState = {
          sessionId,
          scope,
          transport,
          termination: yield* Deferred.make<never, CursorSessionFailure>(),
          chunks: yield* Queue.dropping<CursorUIMessageChunk, Cause.Done | AgentOperationError>(
            SESSION_QUEUE_CAPACITY,
          ),
          requests: yield* Queue.bounded<AgentRequest, Cause.Done>(SESSION_QUEUE_CAPACITY),
          pending: yield* Ref.make<ReadonlyMap<string, PendingRequest>>(new Map()),
          turnState: yield* Ref.make<CursorTurnState>({ _tag: "Idle" }),
          turnEnd: yield* Ref.make<TurnEnd | undefined>(undefined),
          transform: createCursorTransform(sessionId),
        };
        yield* Ref.update(sessions, (current) => new Map(current).set(sessionId, session));
        yield* Stream.runForEach(transport.notifications, (notification) =>
          routeNotification(session, notification),
        ).pipe(
          Effect.catch((error) => reportCrash(session, error)),
          Effect.forkIn(scope),
        );
        yield* Stream.runForEach(transport.serverRequests, (request) =>
          Effect.forkIn(handleServerRequest(session, request), scope).pipe(Effect.asVoid),
        ).pipe(
          Effect.catch((error) => reportCrash(session, error)),
          Effect.forkIn(scope),
        );
        yield* transport.awaitTermination.pipe(
          Effect.catch((error) => reportCrash(session, error)),
          Effect.forkIn(scope),
        );
        return session;
      });

    const openSession = (config: {
      readonly cwd: string;
      readonly resumeId?: string;
    }): Effect.Effect<
      { readonly sessionId: string },
      CursorTransportFailure | SessionNotResumable
    > =>
      Effect.gen(function* () {
        const scope = yield* Scope.fork(ownerScope, "sequential");
        return yield* Effect.gen(function* () {
          const transport = yield* dependencies
            .makeTransport({ cwd: config.cwd })
            .pipe(Effect.provideService(Scope.Scope, scope), Effect.provideContext(buildContext));
          yield* handshake(transport);
          const opened = config.resumeId
            ? yield* transport
                .request("session/load", {
                  sessionId: config.resumeId,
                  cwd: config.cwd,
                  mcpServers: [],
                })
                .pipe(
                  Effect.mapError((cause) =>
                    cause instanceof CursorRpcError
                      ? new SessionNotResumable({
                          sessionId: config.resumeId!,
                          reason: cause.message,
                        })
                      : cause,
                  ),
                )
            : yield* transport.request("session/new", { cwd: config.cwd, mcpServers: [] });
          const sessionId = config.resumeId ?? sessionIdOf(opened);
          if (sessionId === undefined) {
            return yield* new CursorTransportError({
              operation: "session/new",
              cause: new Error("ACP session/new did not return a sessionId"),
            });
          }
          yield* registerSession(sessionId, transport, scope);
          return { sessionId };
        }).pipe(
          Effect.mapError((error) => {
            if (error instanceof SessionNotResumable) return error;
            if (
              error instanceof CursorTransportError ||
              error instanceof CursorRpcError ||
              (typeof error === "object" &&
                error !== null &&
                "_tag" in error &&
                (error._tag === "AgentProcessExited" || error._tag === "AgentProtocolError"))
            ) {
              return error as CursorTransportFailure;
            }
            return new CursorTransportError({ operation: "open-session", cause: error });
          }),
          Effect.onError(() => Scope.close(scope, Exit.void)),
        );
      });

    const interrupt = (sessionId: string): Effect.Effect<void, HarnessSessionNotFound> =>
      Effect.gen(function* () {
        const session = yield* getSession(sessionId);
        const turn = yield* Ref.get(session.turnState);
        if (turn._tag !== "Active") return;
        yield* session.transport
          .notify("session/cancel", { sessionId })
          .pipe(Effect.catch(() => Effect.void));
      });

    const abort = (sessionId: string): Effect.Effect<void, HarnessSessionNotFound> =>
      getSession(sessionId).pipe(
        Effect.flatMap((session) =>
          unregister(session).pipe(
            Effect.andThen(
              session.transport
                .request("session/close", { sessionId })
                .pipe(Effect.catch(() => Effect.void)),
            ),
            Effect.andThen(settlePending(session)),
            Effect.andThen(completeTurn(session)),
            Effect.andThen(Queue.end(session.requests)),
            Effect.andThen(Queue.end(session.chunks)),
            Effect.andThen(closeScope(session)),
            Effect.asVoid,
          ),
        ),
      );

    const injectFinish = (session: SessionState, turnId: string) =>
      Ref.modify<CursorTurnState, Deferred.Deferred<void> | undefined>(
        session.turnState,
        (current) => {
          if (current._tag !== "Active" || current.turnId !== turnId) {
            return [undefined, current] as const;
          }
          return [current.ended, { _tag: "Idle" } as const] as const;
        },
      ).pipe(
        Effect.flatMap((ended) =>
          ended
            ? Ref.update(
                session.turnEnd,
                (current) => current ?? { outcome: "completed" as const },
              ).pipe(
                Effect.andThen(
                  Effect.forEach(session.transform.endTurn(), (chunk) =>
                    offerChunk(session, chunk),
                  ),
                ),
                Effect.andThen(Deferred.succeed(ended, undefined)),
              )
            : Effect.void,
        ),
      );

    return {
      listModels: Effect.gen(function* () {
        const scope = yield* Scope.fork(ownerScope, "sequential");
        return yield* Effect.gen(function* () {
          const transport = yield* dependencies
            .makeTransport({})
            .pipe(Effect.provideService(Scope.Scope, scope), Effect.provideContext(buildContext));
          yield* handshake(transport);
          return unwrapModels(yield* transport.request("cursor/list_available_models", {}));
        }).pipe(Effect.ensuring(Scope.close(scope, Exit.void)));
      }),
      session: {
        create: (config) =>
          openSession({ cwd: config.cwd }).pipe(
            Effect.catchTag("SessionNotResumable", (error) =>
              Effect.fail(new CursorTransportError({ operation: "session/new", cause: error })),
            ),
          ),
        resume: (config) => openSession({ cwd: config.cwd, resumeId: config.sessionId }),
        prompt: (input) =>
          Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              const session = yield* getSession(input.sessionId);
              const turnId = uuid();
              const ended = yield* Deferred.make<void>();
              const taken = yield* Ref.modify<CursorTurnState, boolean>(
                session.turnState,
                (current) => {
                  if (current._tag !== "Idle") return [false, current] as const;
                  return [true, { _tag: "Active", turnId, ended }] as const;
                },
              );
              if (!taken) {
                return yield* new TurnAlreadyRunning({ sessionId: input.sessionId, turnId });
              }

              yield* Ref.set(session.turnEnd, undefined);
              yield* drainQueue(session.chunks);
              yield* Effect.forkIn(
                session.transport
                  .request("session/prompt", {
                    sessionId: input.sessionId,
                    prompt: [{ type: "text", text: input.text }],
                  })
                  .pipe(
                    Effect.flatMap((result) => {
                      const { stopReason } = promptResultOf(result);
                      return Ref.set(session.turnEnd, {
                        outcome: isCancelledStopReason(stopReason)
                          ? ("canceled" as const)
                          : ("completed" as const),
                      }).pipe(
                        Effect.andThen(
                          session.transport.enqueueNotification({
                            method: TURN_END_METHOD,
                            params: { sessionId: input.sessionId },
                          }),
                        ),
                      );
                    }),
                    Effect.catch((error) =>
                      offerChunk(session, { type: "error", errorText: error.message }).pipe(
                        Effect.andThen(injectFinish(session, turnId)),
                      ),
                    ),
                  ),
                session.scope,
              );

              const abandonTurn = settleTurn(session, turnId);

              return {
                turnId,
                started: true,
                output: streamFromQueueOne(session.chunks).pipe(
                  Stream.takeUntil((chunk) => chunk.type === "finish"),
                  Stream.ensuring(abandonTurn),
                ),
                completion: Deferred.await(ended).pipe(
                  Effect.andThen(Ref.get(session.turnEnd)),
                  Effect.map((end) => end ?? { outcome: "completed" as const }),
                ),
              };
            }).pipe(
              Effect.onInterrupt(() =>
                restore(interrupt(input.sessionId)).pipe(Effect.catch(() => Effect.void)),
              ),
            ),
          ),
        setModel: (sessionId, model) =>
          getSession(sessionId).pipe(
            Effect.flatMap((session) =>
              session.transport
                .request("session/set_model", { sessionId, modelId: model })
                .pipe(Effect.asVoid),
            ),
          ),
        setReasoningEffort: (sessionId, effort) =>
          getSession(sessionId).pipe(
            Effect.flatMap((session) =>
              session.transport
                .request("session/set_config_option", {
                  sessionId,
                  configId: "effort",
                  value: effort,
                })
                .pipe(Effect.asVoid),
            ),
          ),
        setPermissionMode: (sessionId, modeId) =>
          getSession(sessionId).pipe(
            Effect.flatMap((session) =>
              session.transport
                .request("session/set_mode", { sessionId, modeId })
                .pipe(Effect.asVoid),
            ),
          ),
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
    } satisfies CursorAgent;
  });

export const makeCursorAgent = (
  options: CursorAgentOptions = {},
): Effect.Effect<
  CursorAgent,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Scope.Scope
> =>
  makeCursorAgentWithDependencies({
    makeTransport: (config) =>
      Effect.gen(function* () {
        const executablePath = options.executablePath ?? (yield* resolveCursorExecutable());
        if (!executablePath) {
          return yield* Effect.fail(
            new CursorTransportError({
              operation: "resolve",
              cause: new Error(cursorNotFoundMessage),
            }),
          );
        }
        return yield* makeCursorTransport({
          executablePath,
          ...(options.args ? { args: options.args } : {}),
          ...(config.cwd ? { cwd: config.cwd } : {}),
        });
      }),
  });
