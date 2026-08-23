import type { AgentRequest, AgentResponse } from "@vibest/contract";
import type { CodexUIMessageChunk } from "@vibest/contract/codex";
import type { ServerNotification, ServerRequest } from "@vibest/contract/codex/protocol";
import type {
  AskForApproval,
  Model,
  ModelListResponse,
  SandboxPolicy,
  ThreadReadResponse,
  ThreadResumeResponse,
  ThreadStartResponse,
  TurnStartResponse,
  TurnSteerResponse,
  UserInput,
} from "@vibest/contract/codex/protocol/v2";
import { Deferred, Effect, Queue, Ref, Scope, Stream } from "effect";
import type * as Cause from "effect/Cause";
import type * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import {
  AgentOperationError,
  AgentRequestUnavailable,
  CodexTransportError,
  HarnessSessionNotFound,
  TurnAlreadyRunning,
} from "../errors";
import { drainQueue, streamFromQueueOne } from "../queue-stream";
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
import { createCodexTransform } from "./transform";
import { makeCodexTransport, type CodexTransport, type CodexTransportFailure } from "./transport";
import { makeCodexTransportHolder } from "./transport-holder";

const CLIENT_INFO = { name: "vibest", title: "Vibest", version: "0.0.0" };
const SESSION_QUEUE_CAPACITY = 1024;
// Guard against a server that keeps handing back a cursor, not a real ceiling:
// no account has anywhere near this many models.
const MAX_MODEL_PAGES = 20;

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

type InterruptDecision =
  | { readonly _tag: "None" }
  | { readonly _tag: "Active"; readonly turnId: string };

type TurnDecision =
  | {
      readonly _tag: "Start";
      readonly token: TurnToken;
      readonly ended: Deferred.Deferred<void>;
    }
  | { readonly _tag: "Steer"; readonly turn: Extract<CodexTurnState, { _tag: "Active" }> }
  | { readonly _tag: "Wait"; readonly ended: Deferred.Deferred<void> }
  | { readonly _tag: "Busy" };

export type CodexSessionFailure = CodexTransportFailure | AgentOperationError;

type SessionState = {
  readonly threadId: string;
  readonly generation: number;
  readonly termination: Deferred.Deferred<never, CodexSessionFailure>;
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

export interface CodexAgentDependencies<R> {
  readonly makeTransport: () => Effect.Effect<CodexTransport, CodexTransportError, R | Scope.Scope>;
  readonly beforeCrashCleanup?: (failure: CodexTransportFailure) => Effect.Effect<void>;
}

export interface CodexAgent {
  /**
   * The model catalog for the signed-in account, read straight from the
   * app-server. Follows the account and the installed codex version, so it can
   * only be probed — never hardcoded.
   */
  readonly listModels: Effect.Effect<ReadonlyArray<Model>, CodexTransportFailure>;
  readonly session: {
    readonly create: (config: {
      readonly cwd: string;
    }) => Effect.Effect<{ readonly sessionId: string }, CodexTransportFailure>;
    readonly resume: (config: {
      readonly sessionId: string;
      readonly cwd?: string;
    }) => Effect.Effect<{ readonly sessionId: string }, CodexTransportFailure>;
    /**
     * Reads a thread's stored metadata (title, recency) straight from the
     * app-server's history — works for threads that aren't loaded as live
     * sessions, so persisted sessions can be given live display data.
     */
    readonly read: (config: {
      readonly sessionId: string;
      /** Include stored turns + items (rollout history) in the reply. */
      readonly includeTurns?: boolean;
    }) => Effect.Effect<ThreadReadResponse["thread"], CodexTransportFailure>;
    readonly prompt: (input: {
      readonly sessionId: string;
      readonly text: string;
      readonly approvalPolicy?: AskForApproval;
      readonly sandboxPolicy?: SandboxPolicy;
      readonly model?: string;
      readonly reasoningEffort?: string;
    }) => Effect.Effect<
      {
        readonly turnId: string;
        readonly started: boolean;
        readonly output: Stream.Stream<CodexUIMessageChunk, AgentOperationError>;
      },
      HarnessSessionNotFound | CodexTransportFailure | AgentOperationError | TurnAlreadyRunning
    >;
    readonly steer: (input: {
      readonly sessionId: string;
      readonly expectedTurnId: string;
      readonly text: string;
    }) => Effect.Effect<void, HarnessSessionNotFound | CodexTransportFailure | TurnAlreadyRunning>;
    readonly requestPermission: (
      sessionId: string,
    ) => Stream.Stream<AgentRequest, HarnessSessionNotFound>;
    readonly awaitTermination: (
      sessionId: string,
    ) => Effect.Effect<never, HarnessSessionNotFound | CodexSessionFailure>;
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
export const makeCodexAgentWithDependencies = <R>(
  dependencies: CodexAgentDependencies<R>,
): Effect.Effect<CodexAgent, never, R | Scope.Scope> =>
  Effect.gen(function* () {
    const ownerScope = yield* Scope.Scope;
    const sessions = yield* Ref.make(new Map<string, SessionState>());
    const nextTransportGeneration = yield* Ref.make(1);
    const transportGenerations = new WeakMap<CodexTransport, number>();

    const getSession = (sessionId: string): Effect.Effect<SessionState, HarnessSessionNotFound> =>
      Ref.get(sessions).pipe(
        Effect.flatMap((current) => {
          const session = current.get(sessionId);
          return session
            ? Effect.succeed(session)
            : Effect.fail(new HarnessSessionNotFound({ sessionId }));
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

    const evictOverflowedSession = (session: SessionState) => {
      const error = overflowError(session);
      return Ref.update(sessions, (current) => {
        if (current.get(session.threadId) !== session) return current;
        const next = new Map(current);
        next.delete(session.threadId);
        return next;
      }).pipe(
        Effect.andThen(Deferred.fail(session.termination, error)),
        Effect.andThen(settlePending(session)),
        Effect.andThen(completeTurn(session)),
        Effect.andThen(Queue.end(session.requests)),
        Effect.andThen(Queue.fail(session.chunks, error)),
        Effect.asVoid,
      );
    };

    const crashSessions = (generation: number, failure: CodexTransportFailure) =>
      Ref.modify(sessions, (current) => {
        const crashed: SessionState[] = [];
        const active = new Map(current);
        for (const [sessionId, session] of current) {
          if (session.generation !== generation) continue;
          active.delete(sessionId);
          crashed.push(session);
        }
        return [crashed, active] as const;
      }).pipe(
        Effect.flatMap((crashed) =>
          Effect.forEach(
            crashed,
            (session) =>
              Deferred.fail(session.termination, failure).pipe(
                Effect.andThen(settlePending(session)),
                Effect.andThen(completeTurn(session)),
                Effect.andThen(Queue.end(session.requests)),
                Effect.andThen(
                  Queue.offer(session.chunks, {
                    type: "error",
                    errorText: failure.message,
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

    const routeNotification = (generation: number, notification: ServerNotification) =>
      Effect.gen(function* () {
        const params = notification.params as { readonly threadId?: string } | undefined;
        if (!params?.threadId) return;
        const session = yield* Ref.get(sessions).pipe(
          Effect.map((current) => current.get(params.threadId!)),
        );
        if (!session || session.generation !== generation) return;
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

    const handleServerRequest = (
      generation: number,
      request: ServerRequest,
    ): Effect.Effect<unknown, Error> => {
      if (isApprovalRequest(request)) {
        const source = approvalSourceOf(request.method);
        return Ref.get(sessions).pipe(
          Effect.map((current) => current.get(request.params.threadId)),
          Effect.flatMap((session) => {
            if (!session || session.generation !== generation) {
              return Effect.succeed(declineResult(source));
            }
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
            if (!session || session.generation !== generation) {
              return Effect.succeed(emptyUserInputResponse());
            }
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

    const reportCrash = (generation: number, error: CodexTransportFailure) =>
      Effect.forkIn(
        (dependencies.beforeCrashCleanup?.(error) ?? Effect.void).pipe(
          Effect.andThen(crashSessions(generation, error)),
        ),
        ownerScope,
      ).pipe(Effect.asVoid);

    const makeInitializedTransport = Effect.gen(function* () {
      const generation = yield* Ref.getAndUpdate(nextTransportGeneration, (current) => current + 1);
      const transport = yield* dependencies.makeTransport();
      transportGenerations.set(transport, generation);

      yield* Stream.runForEach(transport.notifications, (notification) =>
        routeNotification(generation, notification),
      ).pipe(
        Effect.catch((error) => reportCrash(generation, error)),
        Effect.forkScoped,
      );
      yield* Stream.runForEach(transport.serverRequests, (request) =>
        Effect.forkScoped(
          handleServerRequest(generation, request).pipe(
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
      ).pipe(
        Effect.catch((error) => reportCrash(generation, error)),
        Effect.forkScoped,
      );
      yield* transport.awaitTermination.pipe(
        Effect.catch((error) => reportCrash(generation, error)),
        Effect.forkScoped,
      );

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

    const getTransportGeneration = (
      transport: CodexTransport,
    ): Effect.Effect<number, CodexTransportError> =>
      Effect.gen(function* () {
        const generation = transportGenerations.get(transport);
        if (generation !== undefined) return generation;
        return yield* new CodexTransportError({
          operation: "transport-generation",
          cause: new Error("Codex transport has no generation"),
        });
      });

    const steer = (input: {
      readonly sessionId: string;
      readonly expectedTurnId: string;
      readonly text: string;
    }): Effect.Effect<void, HarnessSessionNotFound | CodexTransportFailure | TurnAlreadyRunning> =>
      Effect.gen(function* () {
        const session = yield* getSession(input.sessionId);
        const current = yield* Ref.get(session.turnState);
        if (current._tag !== "Active" || current.turnId !== input.expectedTurnId) {
          return yield* new TurnAlreadyRunning({
            sessionId: input.sessionId,
            ...(current._tag === "Active" ? { turnId: current.turnId } : {}),
          });
        }
        const transport = yield* holder.current;
        if (!transport || transportGenerations.get(transport) !== session.generation) {
          return yield* new CodexTransportError({
            operation: "turn/steer",
            cause: new Error("Codex transport is unavailable"),
          });
        }
        yield* transport.request<TurnSteerResponse>("turn/steer", {
          threadId: session.threadId,
          input: [{ type: "text", text: input.text, text_elements: [] }],
          expectedTurnId: input.expectedTurnId,
        });
      });

    const interrupt = (sessionId: string): Effect.Effect<void, HarnessSessionNotFound> =>
      Effect.gen(function* () {
        const session = yield* getSession(sessionId);
        const decision = yield* Ref.modify<CodexTurnState, InterruptDecision>(
          session.turnState,
          (current) => {
            if (current._tag === "Starting") {
              return [{ _tag: "None" }, { ...current, abandoned: true }] as const;
            }
            if (current._tag === "Active") {
              return [{ _tag: "Active", turnId: current.turnId }, current] as const;
            }
            return [{ _tag: "None" }, current] as const;
          },
        );
        if (decision._tag === "None") return;
        const transport = yield* holder.current;
        if (!transport || transportGenerations.get(transport) !== session.generation) return;
        yield* transport
          .request("turn/interrupt", {
            threadId: session.threadId,
            turnId: decision.turnId,
          })
          .pipe(Effect.catch(() => Effect.void));
      });

    const abort = (sessionId: string): Effect.Effect<void, HarnessSessionNotFound> =>
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
            if (!transport || transportGenerations.get(transport) !== session.generation) return;
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

    const registerSession = (threadId: string, generation: number) =>
      Effect.gen(function* () {
        const state: SessionState = {
          threadId,
          generation,
          termination: yield* Deferred.make<never, CodexSessionFailure>(),
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
      // `includeHidden` is deliberately not sent: the app-server already filters
      // the picker list down to what this account can actually run, which is
      // exactly what the UI should offer.
      //
      // `model/list` is paginated with a server-chosen page size, so a single
      // call is not the catalog — it is the first page of one. Follow the
      // cursor: a truncated list is invisible, the user simply never sees the
      // model they wanted. The page cap is a runaway guard, not a limit anyone
      // is expected to hit.
      listModels: Effect.gen(function* () {
        const transport = yield* holder.ensure;
        const models: Model[] = [];
        let cursor: string | null = null;
        for (let page = 0; page < MAX_MODEL_PAGES; page++) {
          const response: ModelListResponse = yield* transport.request<ModelListResponse>(
            "model/list",
            cursor === null ? {} : { cursor },
          );
          models.push(...response.data);
          cursor = response.nextCursor;
          if (cursor === null) break;
        }
        return models;
      }),
      session: {
        create: (config) =>
          Effect.gen(function* () {
            const transport = yield* holder.ensure;
            const generation = yield* getTransportGeneration(transport);
            const response = yield* transport.request<ThreadStartResponse>("thread/start", {
              cwd: config.cwd,
              approvalPolicy: "on-request",
              sandbox: "workspace-write",
            });
            return yield* registerSession(response.thread.id, generation);
          }),
        resume: (config) =>
          Effect.gen(function* () {
            const transport = yield* holder.ensure;
            const generation = yield* getTransportGeneration(transport);
            const response = yield* transport.request<ThreadResumeResponse>("thread/resume", {
              threadId: config.sessionId,
              cwd: config.cwd,
              approvalPolicy: "on-request",
              sandbox: "workspace-write",
            });
            return yield* registerSession(response.thread.id, generation);
          }),
        read: (config) =>
          Effect.gen(function* () {
            const transport = yield* holder.ensure;
            const response = yield* transport.request<ThreadReadResponse>("thread/read", {
              threadId: config.sessionId,
              ...(config.includeTurns !== undefined ? { includeTurns: config.includeTurns } : {}),
            });
            return response.thread;
          }),
        prompt: (input) =>
          Effect.gen(function* () {
            const session = yield* getSession(input.sessionId);
            const transport = yield* holder.ensure;
            const generation = yield* getTransportGeneration(transport);
            if (generation !== session.generation) {
              return yield* new AgentOperationError({
                sessionId: input.sessionId,
                operation: "transport-generation",
                cause: new Error("Codex session belongs to a terminated transport generation"),
              });
            }
            const turnInput: UserInput[] = [{ type: "text", text: input.text, text_elements: [] }];

            const prepareTurn = (): Effect.Effect<
              {
                readonly turnId: string;
                readonly started: boolean;
                readonly output: Stream.Stream<CodexUIMessageChunk, AgentOperationError>;
              },
              CodexTransportFailure | AgentOperationError | TurnAlreadyRunning
            > =>
              Effect.uninterruptibleMask((restore) =>
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
                    yield* restore(Deferred.await(decision.ended)).pipe(
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
                    return yield* new TurnAlreadyRunning({
                      sessionId: input.sessionId,
                      turnId: decision.turn.turnId,
                    });
                  }

                  yield* drainQueue(session.chunks);
                  const response = yield* transport
                    .request<TurnStartResponse>("turn/start", {
                      threadId: session.threadId,
                      input: turnInput,
                      // Per-turn permission / model override (applies to this
                      // and subsequent turns); omitted keys keep the thread
                      // default. This is also how a model chosen at create time
                      // reaches Codex: `thread/start` fixes one, but the first
                      // turn can override it before the model is ever used.
                      ...(input.approvalPolicy ? { approvalPolicy: input.approvalPolicy } : {}),
                      ...(input.sandboxPolicy ? { sandboxPolicy: input.sandboxPolicy } : {}),
                      ...(input.model ? { model: input.model } : {}),
                      ...(input.reasoningEffort ? { effort: input.reasoningEffort } : {}),
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
                  const shouldInterrupt = yield* Ref.modify(session.turnState, (current) =>
                    current._tag === "Starting" && current.token === decision.token
                      ? ([
                          current.abandoned,
                          {
                            _tag: "Active",
                            token: decision.token,
                            turnId: response.turn.id,
                            ended: decision.ended,
                            abandoned: current.abandoned,
                          } as const,
                        ] as const)
                      : ([true, current] as const),
                  );
                  if (shouldInterrupt) {
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
        steer,
        interrupt,
        abort,
      },
    } satisfies CodexAgent;
  });

export const makeCodexAgent = (
  options: CodexAgentOptions = {},
): Effect.Effect<CodexAgent, never, ChildProcessSpawner.ChildProcessSpawner | Scope.Scope> =>
  makeCodexAgentWithDependencies({ makeTransport: () => makeCodexTransport(options) });
