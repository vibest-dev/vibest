import type { AgentRequest, AgentResponse, TokenUsage } from "@vibest/contract";
import type { GrokUIMessageChunk } from "@vibest/contract/grok";
import { Deferred, Effect, Exit, FileSystem, Queue, Ref, Scope, Stream } from "effect";
import type * as Cause from "effect/Cause";
import type * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { v7 as uuid } from "uuid";

import {
  AgentOperationError,
  AgentRequestUnavailable,
  GrokRpcError,
  GrokTransportError,
  HarnessSessionNotFound,
  SessionNotResumable,
  TurnAlreadyRunning,
} from "../errors";
import { drainQueue, streamFromQueueOne } from "../queue-stream";
import { resolveGrokExecutable } from "./executable";
import {
  CLIENT_INFO,
  isRequestPermission,
  isXaiSessionNotification,
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
import { createGrokTransform } from "./transform";
import { makeGrokTransport, type GrokTransport, type GrokTransportFailure } from "./transport";

const SESSION_QUEUE_CAPACITY = 1024;
const HANDSHAKE_TIMEOUT = "30 seconds";

type PendingRequest = {
  readonly deferred: Deferred.Deferred<unknown>;
  readonly declineValue: unknown;
  readonly settle: (response: AgentResponse) => unknown;
};

type GrokTurnState =
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

export type GrokSessionFailure = GrokTransportFailure | AgentOperationError;

type SessionState = {
  readonly sessionId: string;
  readonly scope: Scope.Closeable;
  readonly transport: GrokTransport;
  readonly termination: Deferred.Deferred<never, GrokSessionFailure>;
  readonly chunks: Queue.Queue<GrokUIMessageChunk, Cause.Done | AgentOperationError>;
  readonly requests: Queue.Queue<AgentRequest, Cause.Done>;
  readonly pending: Ref.Ref<ReadonlyMap<string, PendingRequest>>;
  readonly turnState: Ref.Ref<GrokTurnState>;
  readonly turnEnd: Ref.Ref<TurnEnd | undefined>;
  readonly transform: ReturnType<typeof createGrokTransform>;
};

export interface GrokAgentOptions {
  readonly executablePath?: string;
  readonly args?: ReadonlyArray<string>;
}

export interface GrokAgentDependencies<R> {
  readonly makeTransport: (config: {
    readonly cwd?: string;
  }) => Effect.Effect<GrokTransport, GrokTransportError, R | Scope.Scope>;
}

export interface GrokAgent {
  readonly listModels: Effect.Effect<ModelsListResult, GrokTransportFailure>;
  readonly session: {
    readonly create: (config: {
      readonly cwd: string;
    }) => Effect.Effect<{ readonly sessionId: string }, GrokTransportFailure>;
    readonly resume: (config: {
      readonly sessionId: string;
      readonly cwd: string;
    }) => Effect.Effect<{ readonly sessionId: string }, GrokTransportFailure | SessionNotResumable>;
    readonly prompt: (input: {
      readonly sessionId: string;
      readonly text: string;
    }) => Effect.Effect<
      {
        readonly turnId: string;
        readonly started: boolean;
        readonly output: Stream.Stream<GrokUIMessageChunk, AgentOperationError>;
        readonly completion: Effect.Effect<TurnEnd>;
      },
      HarnessSessionNotFound | GrokTransportFailure | AgentOperationError | TurnAlreadyRunning
    >;
    readonly setModel: (
      sessionId: string,
      model: string,
    ) => Effect.Effect<void, HarnessSessionNotFound | GrokTransportFailure>;
    readonly setPermissionMode: (
      sessionId: string,
      modeId: string,
    ) => Effect.Effect<void, HarnessSessionNotFound | GrokTransportFailure>;
    readonly requestPermission: (
      sessionId: string,
    ) => Stream.Stream<AgentRequest, HarnessSessionNotFound>;
    readonly awaitTermination: (
      sessionId: string,
    ) => Effect.Effect<never, HarnessSessionNotFound | GrokSessionFailure>;
    readonly respondPermission: (
      sessionId: string,
      requestId: string,
      response: AgentResponse,
    ) => Effect.Effect<boolean, HarnessSessionNotFound | AgentRequestUnavailable>;
    readonly interrupt: (sessionId: string) => Effect.Effect<void, HarnessSessionNotFound>;
    readonly abort: (sessionId: string) => Effect.Effect<void, HarnessSessionNotFound>;
  };
}

const initializeParams = {
  protocolVersion: 1,
  clientInfo: CLIENT_INFO,
  clientCapabilities: {},
} as const;

/** @internal */
export const makeGrokAgentWithDependencies = <R>(
  dependencies: GrokAgentDependencies<R>,
): Effect.Effect<GrokAgent, never, R | Scope.Scope> =>
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
        cause: new Error("Grok session event queue overflowed"),
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

    const crashSession = (session: SessionState, failure: GrokSessionFailure) =>
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

    const reportCrash = (session: SessionState, failure: GrokSessionFailure) =>
      Effect.forkIn(crashSession(session, failure), ownerScope).pipe(Effect.asVoid);

    const offerChunk = (session: SessionState, chunk: GrokUIMessageChunk) =>
      Queue.offer(session.chunks, chunk).pipe(
        Effect.flatMap((accepted) => (accepted ? Effect.void : evictOverflowedSession(session))),
      );

    const recordTurnEnd = (session: SessionState, notification: RpcNotification) => {
      if (!isXaiSessionNotification(notification)) return Effect.void;
      const update = notification.params.update;
      if (update?.sessionUpdate !== "turn_completed") return Effect.void;
      const cancelled = update.stop_reason === "cancelled" || update.stop_reason === "canceled";
      const usage = update.usage;
      return Ref.set(session.turnEnd, {
        outcome: cancelled ? ("canceled" as const) : ("completed" as const),
        ...(usage
          ? {
              usage: {
                inputTokens: usage.inputTokens ?? 0,
                outputTokens: usage.outputTokens ?? 0,
                ...(usage.cachedReadTokens !== undefined
                  ? { cacheReadTokens: usage.cachedReadTokens }
                  : {}),
                ...(usage.cacheCreationTokens !== undefined
                  ? { cacheCreationTokens: usage.cacheCreationTokens }
                  : {}),
              },
            }
          : {}),
      });
    };

    const settleTurn = (session: SessionState, turnId: string) =>
      Ref.modify<GrokTurnState, Deferred.Deferred<void> | undefined>(
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
      notification: Parameters<SessionState["transform"]>[0],
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* recordTurnEnd(session, notification);
        for (const chunk of session.transform(notification)) {
          if (chunk.type === "finish") {
            const ended = yield* Ref.modify<GrokTurnState, Deferred.Deferred<void> | undefined>(
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

    const handshake = (transport: GrokTransport): Effect.Effect<void, GrokTransportFailure> =>
      transport.request("initialize", initializeParams).pipe(
        Effect.timeoutOrElse({
          duration: HANDSHAKE_TIMEOUT,
          orElse: () =>
            Effect.fail(
              new GrokTransportError({
                operation: "handshake-timeout",
                cause: new Error("Grok ACP initialize timed out"),
              }),
            ),
        }),
        Effect.asVoid,
      );

    const registerSession = (
      sessionId: string,
      transport: GrokTransport,
      scope: Scope.Closeable,
    ): Effect.Effect<SessionState> =>
      Effect.gen(function* () {
        const session: SessionState = {
          sessionId,
          scope,
          transport,
          termination: yield* Deferred.make<never, GrokSessionFailure>(),
          chunks: yield* Queue.dropping<GrokUIMessageChunk, Cause.Done | AgentOperationError>(
            SESSION_QUEUE_CAPACITY,
          ),
          requests: yield* Queue.bounded<AgentRequest, Cause.Done>(SESSION_QUEUE_CAPACITY),
          pending: yield* Ref.make<ReadonlyMap<string, PendingRequest>>(new Map()),
          turnState: yield* Ref.make<GrokTurnState>({ _tag: "Idle" }),
          turnEnd: yield* Ref.make<TurnEnd | undefined>(undefined),
          transform: createGrokTransform(sessionId),
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
    }): Effect.Effect<{ readonly sessionId: string }, GrokTransportFailure | SessionNotResumable> =>
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
                    cause instanceof GrokRpcError
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
            return yield* new GrokTransportError({
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
              error instanceof GrokTransportError ||
              error instanceof GrokRpcError ||
              (typeof error === "object" &&
                error !== null &&
                "_tag" in error &&
                (error._tag === "AgentProcessExited" || error._tag === "AgentProtocolError"))
            ) {
              return error as GrokTransportFailure;
            }
            return new GrokTransportError({ operation: "open-session", cause: error });
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
      Ref.modify<GrokTurnState, Deferred.Deferred<void> | undefined>(
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
                Effect.andThen(offerChunk(session, { type: "finish" })),
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
          return unwrapModels(yield* transport.request("_x.ai/models/list", {}));
        }).pipe(Effect.ensuring(Scope.close(scope, Exit.void)));
      }),
      session: {
        create: (config) =>
          openSession({ cwd: config.cwd }).pipe(
            Effect.catchTag("SessionNotResumable", (error) =>
              Effect.fail(new GrokTransportError({ operation: "session/new", cause: error })),
            ),
          ),
        resume: (config) => openSession({ cwd: config.cwd, resumeId: config.sessionId }),
        prompt: (input) =>
          Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              const session = yield* getSession(input.sessionId);
              const turnId = uuid();
              const ended = yield* Deferred.make<void>();
              const taken = yield* Ref.modify<GrokTurnState, boolean>(
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
    } satisfies GrokAgent;
  });

const grokNotFoundMessage =
  "Grok was not found. Install it from https://x.ai/cli, or set VIBEST_GROK_EXECUTABLE to the path of the `grok` binary.";

export const makeGrokAgent = (
  options: GrokAgentOptions = {},
): Effect.Effect<
  GrokAgent,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Scope.Scope
> =>
  makeGrokAgentWithDependencies({
    makeTransport: (config) =>
      Effect.gen(function* () {
        const executablePath = options.executablePath ?? (yield* resolveGrokExecutable());
        if (!executablePath) {
          return yield* Effect.fail(
            new GrokTransportError({
              operation: "resolve",
              cause: new Error(grokNotFoundMessage),
            }),
          );
        }
        return yield* makeGrokTransport({
          executablePath,
          ...(options.args ? { args: options.args } : {}),
          ...(config.cwd ? { cwd: config.cwd } : {}),
        });
      }),
  });
