import type * as sdk from "@anthropic-ai/claude-agent-sdk";
import { getSessionInfo, query } from "@anthropic-ai/claude-agent-sdk";
import { Deferred, Effect, Exit, FiberSet, Queue, Ref, Scope, Stream } from "effect";
import type * as Cause from "effect/Cause";
import { v7 as uuid } from "uuid";

import {
  AgentRequestUnavailable,
  ClaudeSdkError,
  SessionNotFound,
  SessionNotResumable,
  TurnAlreadyRunning,
} from "../runtime/errors";
import { drainQueue, streamFromQueueOne } from "../runtime/queue-stream";
import { resolveClaudeExecutable } from "./executable";

const SESSION_QUEUE_CAPACITY = 1024;

export type ToolPermissionRequest = {
  readonly type: "tool-permission-request";
  readonly sessionId: string;
  readonly requestId: string;
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly suggestions?: sdk.PermissionUpdate[];
};

export type ClaudeAgentFailure = SessionNotFound | SessionNotResumable | ClaudeSdkError;
type ClaudeSessionInfo = Awaited<ReturnType<typeof getSessionInfo>>;

type PendingToolPermission = {
  readonly deferred: Deferred.Deferred<sdk.PermissionResult>;
};

type SessionOutput = {
  readonly token: object;
  readonly message: sdk.SDKMessage;
};

type TurnState =
  | { readonly _tag: "Idle" }
  | {
      readonly _tag: "Active";
      readonly token: object;
      readonly abandoned: boolean;
      readonly resultEnqueued: boolean;
    };

type SessionState = {
  readonly sessionId: string;
  readonly query: sdk.Query;
  readonly termination: Deferred.Deferred<never, ClaudeSdkError>;
  readonly scope: Scope.Closeable;
  readonly input: Queue.Queue<sdk.SDKUserMessage, Cause.Done>;
  readonly output: Queue.Queue<SessionOutput, Cause.Done | ClaudeSdkError>;
  readonly permissionRequests: Queue.Queue<ToolPermissionRequest, Cause.Done>;
  readonly pendingPermissions: Ref.Ref<ReadonlyMap<string, PendingToolPermission>>;
  readonly turnState: Ref.Ref<TurnState>;
};

type ResumeDecision =
  | {
      readonly _tag: "Start";
      readonly deferred: Deferred.Deferred<SessionState, ClaudeAgentFailure>;
    }
  | {
      readonly _tag: "Wait";
      readonly deferred: Deferred.Deferred<SessionState, ClaudeAgentFailure>;
    };

export interface ClaudeCodeAgent {
  readonly session: {
    readonly create: Effect.Effect<{ readonly sessionId: string }, ClaudeSdkError>;
    readonly resume: (
      sessionId: string,
    ) => Effect.Effect<{ readonly sessionId: string }, ClaudeAgentFailure>;
    /**
     * Reads stored session metadata (title, recency) from the SDK's on-disk
     * history without opening a live session — `null` when it's unknown. `dir`
     * scopes the lookup to a workspace. Lets persisted sessions get live display
     * data, so the adapter never has to reach into the SDK itself.
     */
    readonly getSessionInfo: (
      sessionId: string,
      options?: { readonly dir?: string },
    ) => Effect.Effect<ClaudeSessionInfo, ClaudeSdkError>;
    readonly prompt: (input: {
      readonly sessionId: string;
      readonly message: sdk.SDKUserMessage["message"];
    }) => Effect.Effect<
      {
        readonly turnId: string;
        readonly output: Stream.Stream<sdk.SDKMessage, ClaudeAgentFailure>;
      },
      ClaudeAgentFailure | TurnAlreadyRunning
    >;
    readonly requestPermission: (
      sessionId: string,
    ) => Stream.Stream<ToolPermissionRequest, ClaudeAgentFailure>;
    readonly awaitTermination: (
      sessionId: string,
    ) => Effect.Effect<never, SessionNotFound | ClaudeSdkError>;
    readonly respondPermission: (
      sessionId: string,
      requestId: string,
      result: sdk.PermissionResult,
    ) => Effect.Effect<boolean, SessionNotFound | AgentRequestUnavailable>;
    readonly setModel: (
      sessionId: string,
      model: string,
    ) => Effect.Effect<void, ClaudeAgentFailure>;
    readonly getSupportedCommands: (
      sessionId: string,
    ) => Effect.Effect<sdk.SlashCommand[], ClaudeAgentFailure>;
    readonly getSupportedModels: (
      sessionId: string,
    ) => Effect.Effect<sdk.ModelInfo[], ClaudeAgentFailure>;
    readonly getMcpServers: (
      sessionId: string,
    ) => Effect.Effect<sdk.McpServerStatus[], ClaudeAgentFailure>;
    readonly interrupt: (
      sessionId: string,
    ) => Effect.Effect<void, SessionNotFound | ClaudeSdkError>;
    readonly abort: (sessionId: string) => Effect.Effect<void, SessionNotFound>;
  };
}

const sdkError = (operation: string, cause: unknown) => new ClaudeSdkError({ operation, cause });

/**
 * Configuration for {@link makeClaudeCodeAgent}. All fields optional.
 *
 * `permissionMode` is forwarded to every Claude Agent SDK session. Leave it
 * unset to let the SDK use its own default; set it to `"bypassPermissions"`
 * to skip permission prompts — the SDK's required
 * `allowDangerouslySkipPermissions: true` is added automatically in that case.
 */
export interface ClaudeCodeAgentOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly permissionMode?: sdk.PermissionMode;
}

export const makeClaudeCodeAgent = ({
  env = process.env,
  permissionMode,
}: ClaudeCodeAgentOptions = {}): Effect.Effect<ClaudeCodeAgent, never, Scope.Scope> =>
  Effect.gen(function* () {
    const ownerScope = yield* Scope.Scope;
    const sessions = yield* Ref.make(new Map<string, SessionState>());
    const resumes = yield* Ref.make(
      new Map<string, Deferred.Deferred<SessionState, ClaudeAgentFailure>>(),
    );

    const getLiveSession = (sessionId: string) =>
      Ref.get(sessions).pipe(
        Effect.flatMap((current) => {
          const session = current.get(sessionId);
          return session
            ? Effect.succeed(session)
            : Effect.fail(new SessionNotFound({ sessionId }));
        }),
      );

    const finishPermissions = (session: SessionState, message: string) =>
      Ref.getAndSet(session.pendingPermissions, new Map()).pipe(
        Effect.flatMap((pending) =>
          Effect.forEach(
            pending.values(),
            ({ deferred }) =>
              Deferred.succeed(deferred, {
                behavior: "deny",
                message,
                interrupt: true,
              }),
            { discard: true },
          ),
        ),
      );

    const closeSession = (session: SessionState) => Scope.close(session.scope, Exit.void);

    const buildSession = (
      sessionId: string,
      identity: Pick<sdk.Options, "sessionId" | "resume">,
    ): Effect.Effect<SessionState, ClaudeSdkError> =>
      Effect.gen(function* () {
        const sessionScope = yield* Scope.fork(ownerScope, "sequential");
        return yield* Effect.gen(function* () {
          const input = yield* Queue.bounded<sdk.SDKUserMessage, Cause.Done>(
            SESSION_QUEUE_CAPACITY,
          );
          const output = yield* Queue.bounded<SessionOutput, Cause.Done | ClaudeSdkError>(
            SESSION_QUEUE_CAPACITY,
          );
          const permissionRequests = yield* Queue.dropping<ToolPermissionRequest, Cause.Done>(
            SESSION_QUEUE_CAPACITY,
          );
          const pendingPermissions = yield* Ref.make<ReadonlyMap<string, PendingToolPermission>>(
            new Map(),
          );
          const turnState = yield* Ref.make<TurnState>({ _tag: "Idle" });
          const termination = yield* Deferred.make<never, ClaudeSdkError>();
          const callbackFibers = yield* FiberSet.make<unknown, never>().pipe(
            Effect.provideService(Scope.Scope, sessionScope),
          );
          const runCallback = yield* FiberSet.runtime(callbackFibers)();
          const runCallbackPromise = yield* FiberSet.runtimePromise(callbackFibers)();

          const canUseTool: NonNullable<sdk.Options["canUseTool"]> = (
            toolName,
            toolInput,
            { signal, suggestions },
          ) => {
            const requestId = uuid();
            const waitForPermission = Effect.gen(function* () {
              const deferred = yield* Deferred.make<sdk.PermissionResult>();
              const onAbort = () => {
                runCallback(
                  Deferred.succeed(deferred, {
                    behavior: "deny",
                    message: `Tool permission for ${toolName} was aborted`,
                    interrupt: true,
                  }),
                );
              };
              signal.addEventListener("abort", onAbort, { once: true });
              yield* Ref.update(pendingPermissions, (current) =>
                new Map(current).set(requestId, { deferred }),
              );
              const accepted = yield* Queue.offer(permissionRequests, {
                type: "tool-permission-request",
                sessionId,
                requestId,
                toolName,
                input: toolInput,
                suggestions,
              });
              if (!accepted) {
                yield* Ref.update(pendingPermissions, (current) => {
                  const next = new Map(current);
                  next.delete(requestId);
                  return next;
                });
                signal.removeEventListener("abort", onAbort);
                return {
                  behavior: "deny" as const,
                  message: `Tool permission for ${toolName} was unavailable`,
                  interrupt: true,
                };
              }
              return yield* Deferred.await(deferred).pipe(
                Effect.ensuring(
                  Ref.update(pendingPermissions, (current) => {
                    const next = new Map(current);
                    next.delete(requestId);
                    return next;
                  }).pipe(
                    Effect.andThen(Effect.sync(() => signal.removeEventListener("abort", onAbort))),
                  ),
                ),
              );
            });
            return runCallbackPromise(waitForPermission);
          };

          const queryOptions: sdk.Options = {
            mcpServers: {},
            strictMcpConfig: true,
            permissionMode,
            ...(permissionMode === "bypassPermissions"
              ? { allowDangerouslySkipPermissions: true }
              : {}),
            stderr: (error) => console.error(error),
            executable: process.execPath as "node",
            pathToClaudeCodeExecutable: resolveClaudeExecutable({ env }),
            env: { ...env },
            systemPrompt: { type: "preset", preset: "claude_code" },
            settingSources: ["user", "project", "local"],
            canUseTool,
            ...identity,
          };
          const queryInstance = yield* Effect.try({
            try: () =>
              query({
                prompt: Stream.toAsyncIterable(Stream.fromQueue(input)),
                options: queryOptions,
              }),
            catch: (cause) => sdkError("query", cause),
          });
          const state: SessionState = {
            sessionId,
            query: queryInstance,
            termination,
            scope: sessionScope,
            input,
            output,
            permissionRequests,
            pendingPermissions,
            turnState,
          };

          const removeAndCloseSession = Ref.update(sessions, (current) => {
            if (current.get(sessionId) !== state) return current;
            const next = new Map(current);
            next.delete(sessionId);
            return next;
          }).pipe(Effect.andThen(Scope.close(sessionScope, Exit.void)));

          const closeFromOwner = Effect.forkIn(removeAndCloseSession, ownerScope).pipe(
            Effect.asVoid,
          );

          const failSession = (error: ClaudeSdkError) =>
            Deferred.fail(termination, error).pipe(
              Effect.andThen(Queue.fail(output, error)),
              Effect.andThen(closeFromOwner),
              Effect.asVoid,
            );

          const pump: Effect.Effect<void> = Effect.suspend(() =>
            Effect.tryPromise({
              try: () => queryInstance.next(),
              catch: (cause) => sdkError("query-next", cause),
            }).pipe(
              Effect.flatMap(({ done, value }) =>
                Effect.gen(function* () {
                  if (done || !value) {
                    yield* failSession(
                      sdkError("query-ended", new Error("Claude SDK query ended unexpectedly")),
                    );
                    return;
                  }

                  const token =
                    value.type === "result"
                      ? yield* Ref.modify(turnState, (current) => {
                          if (current._tag !== "Active") return [undefined, current] as const;
                          return current.abandoned
                            ? [undefined, { _tag: "Idle" } as const]
                            : [current.token, { ...current, resultEnqueued: true } as const];
                        })
                      : yield* Ref.get(turnState).pipe(
                          Effect.map((current) =>
                            current._tag === "Active" ? current.token : undefined,
                          ),
                        );
                  if (!token) return yield* pump;

                  const accepted = yield* Queue.offer(output, { token, message: value });
                  if (accepted) yield* pump;
                }),
              ),
              Effect.catch(failSession),
            ),
          );

          yield* Scope.addFinalizer(
            sessionScope,
            finishPermissions(state, "Request aborted due to session termination").pipe(
              Effect.andThen(Queue.end(permissionRequests)),
              Effect.andThen(Queue.end(input)),
              Effect.andThen(Queue.end(output)),
              Effect.andThen(
                Effect.tryPromise({
                  try: () => Promise.resolve(queryInstance.interrupt()),
                  catch: () => undefined,
                }).pipe(Effect.catch(() => Effect.void)),
              ),
              Effect.asVoid,
            ),
          );
          yield* Effect.forkIn(pump, sessionScope);
          yield* Ref.update(sessions, (current) => new Map(current).set(sessionId, state));
          return state;
        }).pipe(Effect.onError(() => Scope.close(sessionScope, Exit.void)));
      }).pipe(
        Effect.onError(() =>
          Ref.update(sessions, (current) => {
            const next = new Map(current);
            next.delete(sessionId);
            return next;
          }),
        ),
      );

    const resume = (sessionId: string): Effect.Effect<SessionState, ClaudeAgentFailure> =>
      Effect.tryPromise<ClaudeSessionInfo, ClaudeSdkError>({
        try: () => getSessionInfo(sessionId),
        catch: (cause) => sdkError("get-session-info", cause),
      }).pipe(
        Effect.flatMap(
          (info): Effect.Effect<SessionState, SessionNotResumable | ClaudeSdkError> =>
            info
              ? buildSession(sessionId, { resume: sessionId })
              : Effect.fail(new SessionNotResumable({ sessionId })),
        ),
      );

    const ensure = (sessionId: string): Effect.Effect<SessionState, ClaudeAgentFailure> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const existing = yield* Ref.get(sessions).pipe(
            Effect.map((current) => current.get(sessionId)),
          );
          if (existing) return existing;

          const candidate = yield* Deferred.make<SessionState, ClaudeAgentFailure>();
          const decision = yield* Ref.modify<
            Map<string, Deferred.Deferred<SessionState, ClaudeAgentFailure>>,
            ResumeDecision
          >(resumes, (current) => {
            const inFlight = current.get(sessionId);
            if (inFlight) return [{ _tag: "Wait", deferred: inFlight }, current];
            return [
              { _tag: "Start", deferred: candidate },
              new Map(current).set(sessionId, candidate),
            ];
          });

          if (decision._tag === "Start") {
            yield* Effect.forkIn(
              resume(sessionId).pipe(
                Effect.exit,
                Effect.flatMap((exit) => Deferred.done(decision.deferred, exit)),
                Effect.ensuring(
                  Ref.update(resumes, (current) => {
                    if (current.get(sessionId) !== decision.deferred) return current;
                    const next = new Map(current);
                    next.delete(sessionId);
                    return next;
                  }),
                ),
              ),
              ownerScope,
            );
          }
          return yield* restore(Deferred.await(decision.deferred));
        }),
      );

    const callQuery = <A>(
      sessionId: string,
      operation: string,
      run: (query: sdk.Query) => Promise<A>,
    ): Effect.Effect<A, ClaudeAgentFailure> =>
      ensure(sessionId).pipe(
        Effect.flatMap((session) =>
          Effect.tryPromise({
            try: () => run(session.query),
            catch: (cause) => sdkError(operation, cause),
          }),
        ),
      );

    return {
      session: {
        create: Effect.gen(function* () {
          const sessionId = uuid();
          yield* buildSession(sessionId, { sessionId });
          return { sessionId };
        }),
        resume: (sessionId) => ensure(sessionId).pipe(Effect.as({ sessionId })),
        prompt: (input) =>
          Effect.gen(function* () {
            const session = yield* ensure(input.sessionId);
            const token = {};
            const started = yield* Ref.modify(session.turnState, (current) =>
              current._tag === "Idle"
                ? [
                    true,
                    {
                      _tag: "Active",
                      token,
                      abandoned: false,
                      resultEnqueued: false,
                    } as const,
                  ]
                : [false, current],
            );
            if (!started) {
              return yield* new TurnAlreadyRunning({ sessionId: input.sessionId });
            }

            yield* drainQueue(session.output);
            const accepted = yield* Queue.offer(session.input, {
              type: "user",
              message: input.message,
              parent_tool_use_id: null,
              session_id: input.sessionId,
            });
            if (!accepted) {
              yield* Ref.update(session.turnState, (current) =>
                current._tag === "Active" && current.token === token
                  ? ({ _tag: "Idle" } as const)
                  : current,
              );
              return yield* sdkError("prompt", new Error("Claude input is closed"));
            }

            return {
              turnId: uuid(),
              output: streamFromQueueOne(session.output).pipe(
                Stream.filter((output) => output.token === token),
                Stream.map((output) => output.message),
                Stream.tap((message) =>
                  message.type === "result"
                    ? Ref.update(session.turnState, (current) =>
                        current._tag === "Active" && current.token === token
                          ? ({ _tag: "Idle" } as const)
                          : current,
                      )
                    : Effect.void,
                ),
                Stream.takeUntil((message) => message.type === "result"),
                Stream.ensuring(
                  Ref.update(session.turnState, (current) => {
                    if (current._tag !== "Active" || current.token !== token) return current;
                    return current.resultEnqueued
                      ? ({ _tag: "Idle" } as const)
                      : ({ ...current, abandoned: true } as const);
                  }),
                ),
              ),
            };
          }),
        requestPermission: (sessionId) =>
          Stream.unwrap(
            ensure(sessionId).pipe(
              Effect.map((session) => streamFromQueueOne(session.permissionRequests)),
            ),
          ),
        awaitTermination: (sessionId) =>
          getLiveSession(sessionId).pipe(
            Effect.flatMap((session) => Deferred.await(session.termination)),
          ),
        respondPermission: (sessionId, requestId, result) =>
          Effect.gen(function* () {
            const session = yield* getLiveSession(sessionId);
            const pending = yield* Ref.modify(session.pendingPermissions, (current) => {
              const request = current.get(requestId);
              if (!request) return [undefined, current] as const;
              const next = new Map(current);
              next.delete(requestId);
              return [request, next] as const;
            });
            if (!pending) {
              return yield* new AgentRequestUnavailable({ sessionId, requestId });
            }
            yield* Deferred.succeed(pending.deferred, result);
            return true;
          }),
        getSessionInfo: (sessionId, options) =>
          Effect.tryPromise<ClaudeSessionInfo, ClaudeSdkError>({
            try: () => getSessionInfo(sessionId, options?.dir ? { dir: options.dir } : undefined),
            catch: (cause) => sdkError("get-session-info", cause),
          }),
        setModel: (sessionId, model) =>
          callQuery(sessionId, "set-model", (sdkQuery) => sdkQuery.setModel(model)),
        getSupportedCommands: (sessionId) =>
          callQuery(sessionId, "supported-commands", (sdkQuery) => sdkQuery.supportedCommands()),
        getSupportedModels: (sessionId) =>
          callQuery(sessionId, "supported-models", (sdkQuery) => sdkQuery.supportedModels()),
        getMcpServers: (sessionId) =>
          callQuery(sessionId, "mcp-server-status", (sdkQuery) => sdkQuery.mcpServerStatus()),
        interrupt: (sessionId) =>
          getLiveSession(sessionId).pipe(
            Effect.flatMap((session) =>
              Effect.tryPromise({
                try: () => Promise.resolve(session.query.interrupt()),
                catch: (cause) => sdkError("interrupt", cause),
              }),
            ),
          ),
        abort: (sessionId) =>
          Effect.gen(function* () {
            const session = yield* getLiveSession(sessionId);
            yield* Ref.update(sessions, (current) => {
              const next = new Map(current);
              next.delete(sessionId);
              return next;
            });
            yield* closeSession(session);
          }),
      },
    } satisfies ClaudeCodeAgent;
  });
