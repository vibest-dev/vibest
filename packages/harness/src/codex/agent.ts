import { Deferred, Effect, Queue, Ref, Scope, Stream } from "effect";
import type * as Cause from "effect/Cause";
import type * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import {
  AgentOperationError,
  AgentRequestUnavailable,
  CodexTransportError,
  SessionNotFound,
  TurnAlreadyRunning,
} from "../runtime/errors";
import { drainQueue, streamFromQueueOne } from "../runtime/queue-stream";
import type { AgentRequest, AgentResponse } from "../types/request";
import type { ServerNotification, ServerRequest } from "./protocol";
import type {
  ThreadResumeResponse,
  ThreadStartResponse,
  TurnStartResponse,
  TurnSteerResponse,
  UserInput,
} from "./protocol/v2";
import {
  approvalSourceOf,
  buildApprovalRequest,
  buildUserInputRequest,
  declineResult,
  emptyUserInputResponse,
  isApprovalRequest,
  isUserInputRequest,
  mapApprovalResponse,
  mapUserInputResponse,
} from "./request";
import {
  makeCodexTransport,
  makeCodexTransportHolder,
  type CodexTransportFailure,
} from "./runtime";
import { createCodexTransform } from "./transform";
import type { CodexUIMessageChunk } from "./ui-message";

const CLIENT_INFO = { name: "vibest", title: "Vibest", version: "0.0.0" };
const SESSION_QUEUE_CAPACITY = 1024;

type PendingRequest = {
  readonly deferred: Deferred.Deferred<unknown>;
  readonly declineValue: unknown;
  readonly settle: (response: AgentResponse) => unknown;
};

type TurnToken = object;

type CodexTurnState =
  | { readonly _tag: "Idle" }
  | {
      readonly _tag: "Starting";
      readonly token: TurnToken;
      readonly ended: Deferred.Deferred<void>;
      readonly abandoned: boolean;
    }
  | {
      readonly _tag: "Active";
      readonly token: TurnToken;
      readonly turnId: string;
      readonly ended: Deferred.Deferred<void>;
      readonly abandoned: boolean;
    }
  | {
      readonly _tag: "Finishing";
      readonly token: TurnToken;
      readonly ended: Deferred.Deferred<void>;
    };

type FinishTransition = {
  readonly deliver: boolean;
  readonly ended: Deferred.Deferred<void> | undefined;
};

type TurnDecision =
  | {
      readonly _tag: "Start";
      readonly token: TurnToken;
      readonly ended: Deferred.Deferred<void>;
    }
  | { readonly _tag: "Steer"; readonly turn: Extract<CodexTurnState, { _tag: "Active" }> }
  | { readonly _tag: "Wait"; readonly ended: Deferred.Deferred<void> }
  | { readonly _tag: "Busy" };

type SessionState = {
  readonly threadId: string;
  readonly chunks: Queue.Queue<CodexUIMessageChunk, Cause.Done | AgentOperationError>;
  readonly requests: Queue.Queue<AgentRequest, Cause.Done>;
  readonly pending: Ref.Ref<ReadonlyMap<string, PendingRequest>>;
  readonly turnState: Ref.Ref<CodexTurnState>;
  readonly transform: ReturnType<typeof createCodexTransform>;
};

export interface CodexAgentOptions {
  readonly executablePath?: string;
  readonly cwd?: string;
  readonly args?: ReadonlyArray<string>;
}

export interface CodexAgent {
  readonly session: {
    readonly create: (config: {
      readonly workspacePath: string;
    }) => Effect.Effect<{ readonly sessionId: string }, CodexTransportFailure>;
    readonly resume: (config: {
      readonly sessionId: string;
      readonly workspacePath?: string;
    }) => Effect.Effect<{ readonly sessionId: string }, CodexTransportFailure>;
    readonly prompt: (input: {
      readonly sessionId: string;
      readonly text: string;
    }) => Effect.Effect<
      {
        readonly turnId: string;
        readonly started: boolean;
        readonly output: Stream.Stream<CodexUIMessageChunk, AgentOperationError>;
      },
      SessionNotFound | CodexTransportFailure | AgentOperationError | TurnAlreadyRunning
    >;
    readonly requestPermission: (sessionId: string) => Stream.Stream<AgentRequest, SessionNotFound>;
    readonly respondPermission: (
      sessionId: string,
      requestId: string,
      response: AgentResponse,
    ) => Effect.Effect<boolean, SessionNotFound | AgentRequestUnavailable>;
    readonly interrupt: (sessionId: string) => Effect.Effect<void, SessionNotFound>;
    readonly abort: (sessionId: string) => Effect.Effect<void, SessionNotFound>;
  };
}

export const makeCodexAgent = (
  options: CodexAgentOptions = {},
): Effect.Effect<CodexAgent, never, ChildProcessSpawner.ChildProcessSpawner | Scope.Scope> =>
  Effect.gen(function* () {
    const ownerScope = yield* Scope.Scope;
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
          turn._tag === "Starting" || turn._tag === "Active" || turn._tag === "Finishing"
            ? Deferred.succeed(turn.ended, undefined).pipe(Effect.asVoid)
            : Effect.void,
        ),
      );

    const closeSessionQueues = (session: SessionState) =>
      completeTurn(session).pipe(
        Effect.andThen(Queue.end(session.requests)),
        Effect.andThen(Queue.end(session.chunks)),
        Effect.asVoid,
      );

    const overflowError = (session: SessionState) =>
      new AgentOperationError({
        sessionId: session.threadId,
        operation: "event-queue-overflow",
        cause: new Error("Codex session event queue overflowed"),
      });

    const evictOverflowedSession = (session: SessionState) =>
      Ref.update(sessions, (current) => {
        if (current.get(session.threadId) !== session) return current;
        const next = new Map(current);
        next.delete(session.threadId);
        return next;
      }).pipe(
        Effect.andThen(settlePending(session)),
        Effect.andThen(Queue.end(session.requests)),
        Effect.andThen(Queue.fail(session.chunks, overflowError(session))),
        Effect.asVoid,
      );

    const crashSessions = (reason: string) =>
      Ref.getAndSet(sessions, new Map()).pipe(
        Effect.flatMap((current) =>
          Effect.forEach(
            current.values(),
            (session) =>
              settlePending(session).pipe(
                Effect.andThen(Queue.end(session.requests)),
                Effect.andThen(
                  Queue.offer(session.chunks, {
                    type: "error",
                    errorText: reason,
                  }),
                ),
                Effect.flatMap((accepted) =>
                  accepted
                    ? Queue.end(session.chunks).pipe(Effect.asVoid)
                    : Queue.fail(session.chunks, overflowError(session)).pipe(Effect.asVoid),
                ),
              ),
            { discard: true },
          ),
        ),
      );

    const routeNotification = (notification: ServerNotification) =>
      Effect.gen(function* () {
        const params = notification.params as { readonly threadId?: string } | undefined;
        if (!params?.threadId) return;
        const session = yield* Ref.get(sessions).pipe(
          Effect.map((current) => current.get(params.threadId!)),
        );
        if (!session) return;
        for (const chunk of session.transform(notification)) {
          if (chunk.type === "finish") {
            const transition = yield* Ref.modify<CodexTurnState, FinishTransition>(
              session.turnState,
              (current) => {
                if (current._tag !== "Starting" && current._tag !== "Active") {
                  return [{ deliver: false, ended: undefined }, current] as const;
                }
                return current.abandoned
                  ? ([{ deliver: false, ended: current.ended }, { _tag: "Idle" } as const] as const)
                  : ([
                      { deliver: true, ended: undefined },
                      {
                        _tag: "Finishing",
                        token: current.token,
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

    const handleServerRequest = (request: ServerRequest): Effect.Effect<unknown, Error> => {
      if (isApprovalRequest(request)) {
        const source = approvalSourceOf(request.method);
        return Ref.get(sessions).pipe(
          Effect.map((current) => current.get(request.params.threadId)),
          Effect.flatMap((session) => {
            if (!session) return Effect.succeed(declineResult(source));
            return awaitAgentResponse(
              session,
              buildApprovalRequest(request),
              (response) => mapApprovalResponse(response, source),
              declineResult(source),
            );
          }),
        );
      }
      if (isUserInputRequest(request)) {
        return Ref.get(sessions).pipe(
          Effect.map((current) => current.get(request.params.threadId)),
          Effect.flatMap((session) => {
            if (!session) return Effect.succeed(emptyUserInputResponse());
            return awaitAgentResponse(
              session,
              buildUserInputRequest(request),
              mapUserInputResponse,
              emptyUserInputResponse(),
            );
          }),
        );
      }
      return Effect.fail(new Error(`Unhandled codex server request: ${request.method}`));
    };

    const reportCrash = (error: CodexTransportFailure) =>
      Effect.forkIn(crashSessions(error.message), ownerScope).pipe(Effect.asVoid);

    const makeInitializedTransport = Effect.gen(function* () {
      const transport = yield* makeCodexTransport(options);

      yield* Stream.runForEach(transport.notifications, routeNotification).pipe(
        Effect.catch(reportCrash),
        Effect.forkScoped,
      );
      yield* Stream.runForEach(transport.serverRequests, (request) =>
        Effect.forkScoped(
          handleServerRequest(request).pipe(
            Effect.flatMap((result) => transport.respond(request.id, result ?? null)),
            Effect.catch((error) =>
              transport
                .respondError(request.id, {
                  code: -32603,
                  message: error instanceof Error ? error.message : String(error),
                })
                .pipe(Effect.catch(() => Effect.void)),
            ),
          ),
        ).pipe(Effect.asVoid),
      ).pipe(Effect.catch(reportCrash), Effect.forkScoped);
      yield* transport.awaitTermination.pipe(Effect.catch(reportCrash), Effect.forkScoped);

      yield* transport
        .request("initialize", {
          clientInfo: CLIENT_INFO,
          capabilities: null,
        })
        .pipe(
          Effect.timeoutOrElse({
            duration: "30 seconds",
            orElse: () =>
              Effect.fail(
                new CodexTransportError({
                  operation: "initialize-timeout",
                  cause: new Error("Codex app-server initialize timed out"),
                }),
              ),
          }),
        );
      yield* transport.notify("initialized");
      return transport;
    }).pipe(
      Effect.mapError((error) =>
        error instanceof CodexTransportError
          ? error
          : new CodexTransportError({ operation: "initialize", cause: error }),
      ),
    );

    const holder = yield* makeCodexTransportHolder({
      makeTransport: () => makeInitializedTransport,
    });

    const interrupt = (sessionId: string): Effect.Effect<void, SessionNotFound> =>
      Effect.gen(function* () {
        const session = yield* getSession(sessionId);
        const turn = yield* Ref.get(session.turnState);
        if (turn._tag !== "Active") return;
        const transport = yield* holder.current;
        if (!transport) return;
        yield* transport
          .request("turn/interrupt", {
            threadId: session.threadId,
            turnId: turn.turnId,
          })
          .pipe(Effect.catch(() => Effect.void));
      });

    const abort = (sessionId: string): Effect.Effect<void, SessionNotFound> =>
      getSession(sessionId).pipe(
        Effect.flatMap((session) =>
          Effect.gen(function* () {
            yield* Ref.update(sessions, (current) => {
              const next = new Map(current);
              next.delete(sessionId);
              return next;
            });
            yield* settlePending(session);

            const turn = yield* Ref.getAndSet(session.turnState, { _tag: "Idle" });
            if (turn._tag !== "Idle") yield* Deferred.succeed(turn.ended, undefined);

            const transport = yield* holder.current;
            if (!transport) return;
            if (turn._tag === "Active") {
              yield* transport
                .request("turn/interrupt", {
                  threadId: session.threadId,
                  turnId: turn.turnId,
                })
                .pipe(Effect.catch(() => Effect.void));
            }
            yield* transport
              .request("thread/unsubscribe", { threadId: session.threadId })
              .pipe(Effect.catch(() => Effect.void));
          }).pipe(Effect.ensuring(closeSessionQueues(session))),
        ),
      );

    const registerSession = (threadId: string) =>
      Effect.gen(function* () {
        const state: SessionState = {
          threadId,
          chunks: yield* Queue.dropping<CodexUIMessageChunk, Cause.Done | AgentOperationError>(
            SESSION_QUEUE_CAPACITY,
          ),
          requests: yield* Queue.bounded<AgentRequest, Cause.Done>(SESSION_QUEUE_CAPACITY),
          pending: yield* Ref.make<ReadonlyMap<string, PendingRequest>>(new Map()),
          turnState: yield* Ref.make<CodexTurnState>({ _tag: "Idle" }),
          transform: createCodexTransform(),
        };
        yield* Ref.update(sessions, (current) => new Map(current).set(threadId, state));
        return { sessionId: threadId };
      });

    return {
      session: {
        create: (config) =>
          Effect.gen(function* () {
            const transport = yield* holder.ensure;
            const response = yield* transport.request<ThreadStartResponse>("thread/start", {
              cwd: config.workspacePath,
              approvalPolicy: "on-request",
              sandbox: "workspace-write",
            });
            return yield* registerSession(response.thread.id);
          }),
        resume: (config) =>
          Effect.gen(function* () {
            const transport = yield* holder.ensure;
            const response = yield* transport.request<ThreadResumeResponse>("thread/resume", {
              threadId: config.sessionId,
              cwd: config.workspacePath,
              approvalPolicy: "on-request",
              sandbox: "workspace-write",
            });
            return yield* registerSession(response.thread.id);
          }),
        prompt: (input) =>
          Effect.gen(function* () {
            const session = yield* getSession(input.sessionId);
            const transport = yield* holder.ensure;
            const turnInput: UserInput[] = [{ type: "text", text: input.text, text_elements: [] }];

            const prepareTurn = (): Effect.Effect<
              {
                readonly turnId: string;
                readonly started: boolean;
                readonly output: Stream.Stream<CodexUIMessageChunk, AgentOperationError>;
              },
              CodexTransportFailure | AgentOperationError | TurnAlreadyRunning
            > =>
              Effect.gen(function* () {
                const token: TurnToken = {};
                const ended = yield* Deferred.make<void>();
                const decision = yield* Ref.modify<CodexTurnState, TurnDecision>(
                  session.turnState,
                  (current) => {
                    switch (current._tag) {
                      case "Idle":
                        return [
                          { _tag: "Start", token, ended },
                          { _tag: "Starting", token, ended, abandoned: false },
                        ];
                      case "Active":
                        return [{ _tag: "Steer", turn: current }, current];
                      case "Starting":
                        return [{ _tag: "Busy" }, current];
                      case "Finishing":
                        return [{ _tag: "Wait", ended: current.ended }, current];
                    }
                  },
                );

                if (decision._tag === "Busy") {
                  return yield* new TurnAlreadyRunning({ sessionId: input.sessionId });
                }
                if (decision._tag === "Wait") {
                  yield* Deferred.await(decision.ended).pipe(
                    Effect.timeoutOrElse({
                      duration: "2 seconds",
                      orElse: () =>
                        Effect.fail(
                          new AgentOperationError({
                            sessionId: input.sessionId,
                            operation: "wait-for-finish-consumption",
                            cause: new Error("Timed out waiting for the previous Codex stream"),
                          }),
                        ),
                    }),
                  );
                  return yield* Effect.suspend(prepareTurn);
                }
                if (decision._tag === "Steer") {
                  const steered = yield* transport
                    .request<TurnSteerResponse>("turn/steer", {
                      threadId: session.threadId,
                      input: turnInput,
                      expectedTurnId: decision.turn.turnId,
                    })
                    .pipe(
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
                  yield* Deferred.await(decision.turn.ended).pipe(
                    Effect.timeoutOrElse({
                      duration: "2 seconds",
                      orElse: () =>
                        Effect.fail(
                          new AgentOperationError({
                            sessionId: input.sessionId,
                            operation: "wait-for-stale-turn",
                            cause: new Error("Timed out waiting for the previous Codex turn"),
                          }),
                        ),
                    }),
                  );
                  return yield* Effect.suspend(prepareTurn);
                }

                yield* drainQueue(session.chunks);
                const response = yield* transport
                  .request<TurnStartResponse>("turn/start", {
                    threadId: session.threadId,
                    input: turnInput,
                  })
                  .pipe(
                    Effect.tapError(() =>
                      Ref.update(session.turnState, (current) =>
                        (current._tag === "Starting" || current._tag === "Finishing") &&
                        current.token === decision.token
                          ? ({ _tag: "Idle" } as const)
                          : current,
                      ).pipe(Effect.andThen(Deferred.succeed(decision.ended, undefined))),
                    ),
                  );
                const activated = yield* Ref.modify(session.turnState, (current) =>
                  current._tag === "Starting" && current.token === decision.token
                    ? ([
                        true,
                        {
                          _tag: "Active",
                          token: decision.token,
                          turnId: response.turn.id,
                          ended: decision.ended,
                          abandoned: current.abandoned,
                        } as const,
                      ] as const)
                    : ([false, current] as const),
                );
                if (!activated) {
                  yield* transport
                    .request("turn/interrupt", {
                      threadId: session.threadId,
                      turnId: response.turn.id,
                    })
                    .pipe(Effect.catch(() => Effect.void));
                }

                const finishConsumed = Ref.modify(session.turnState, (current) => {
                  if (current._tag !== "Idle" && current.token === decision.token) {
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
                  if (current._tag === "Idle" || current.token !== decision.token) {
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
                  turnId: response.turn.id,
                  started: true,
                  output: streamFromQueueOne(session.chunks).pipe(
                    Stream.tap((chunk) => (chunk.type === "finish" ? finishConsumed : Effect.void)),
                    Stream.takeUntil((chunk) => chunk.type === "finish"),
                    Stream.ensuring(abandonTurn),
                  ),
                };
              });

            return yield* prepareTurn();
          }),
        requestPermission: (sessionId) =>
          Stream.unwrap(
            getSession(sessionId).pipe(
              Effect.map((session) => streamFromQueueOne(session.requests)),
            ),
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
    } satisfies CodexAgent;
  });
