import os from "node:os";
import path from "node:path";

import type * as sdk from "@anthropic-ai/claude-agent-sdk";
import { getSessionInfo, query } from "@anthropic-ai/claude-agent-sdk";
import {
  Deferred,
  Effect,
  Exit,
  FiberSet,
  FileSystem,
  Queue,
  Ref,
  Scope,
  Semaphore,
  Stream,
} from "effect";
import type * as Cause from "effect/Cause";
import { v7 as uuid } from "uuid";

import {
  AgentRequestUnavailable,
  ClaudeSdkError,
  HarnessSessionNotFound,
  SessionNotResumable,
  TurnAlreadyRunning,
} from "../errors";
import { drainQueue, streamFromQueueOne } from "../queue-stream";
import { resolveClaudeExecutable } from "./executable";
import { parseTranscriptRecords } from "./transcript";

const SESSION_QUEUE_CAPACITY = 1024;

export type ToolPermissionRequest = {
  readonly type: "tool-permission-request";
  readonly sessionId: string;
  readonly requestId: string;
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly suggestions?: sdk.PermissionUpdate[];
};

export type ClaudeAgentFailure = HarnessSessionNotFound | SessionNotResumable | ClaudeSdkError;
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
      readonly turnId: string;
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
  readonly turnPermit: Semaphore.Semaphore;
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
  /**
   * The models a session started in `cwd` could run, read without opening a
   * session. The catalog follows the user's account and the resolved CLI, so
   * it can only be probed — never hardcoded. The directory is not incidental:
   * a project's `.claude/settings.json` can remap what an id resolves to, so
   * the same `sonnet` is a different model in two projects.
   */
  readonly listModels: (cwd: string) => Effect.Effect<sdk.ModelInfo[], ClaudeSdkError>;
  readonly session: {
    /** `cwd` is the session's working directory; the SDK defaults to `process.cwd()`. */
    readonly create: (input?: {
      readonly cwd?: string;
    }) => Effect.Effect<{ readonly sessionId: string }, ClaudeSdkError>;
    readonly resume: (input: {
      readonly sessionId: string;
      readonly cwd?: string;
    }) => Effect.Effect<{ readonly sessionId: string }, ClaudeAgentFailure>;
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
    /**
     * Reads the session's transcript records from the SDK's on-disk history
     * without touching the live query — the raw material for a history fold.
     */
    readonly getSessionMessages: (
      sessionId: string,
      options?: { readonly dir?: string },
    ) => Effect.Effect<sdk.SessionMessage[], ClaudeSdkError>;
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
    readonly steer: (input: {
      readonly sessionId: string;
      readonly expectedTurnId: string;
      readonly message: sdk.SDKUserMessage["message"];
    }) => Effect.Effect<void, ClaudeAgentFailure | TurnAlreadyRunning>;
    readonly requestPermission: (
      sessionId: string,
    ) => Stream.Stream<ToolPermissionRequest, ClaudeAgentFailure>;
    readonly awaitTermination: (
      sessionId: string,
    ) => Effect.Effect<never, HarnessSessionNotFound | ClaudeSdkError>;
    readonly respondPermission: (
      sessionId: string,
      requestId: string,
      result: sdk.PermissionResult,
    ) => Effect.Effect<boolean, HarnessSessionNotFound | AgentRequestUnavailable>;
    readonly setModel: (
      sessionId: string,
      model: string,
    ) => Effect.Effect<void, ClaudeAgentFailure>;
    readonly setPermissionMode: (
      sessionId: string,
      mode: sdk.PermissionMode,
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
    ) => Effect.Effect<void, HarnessSessionNotFound | ClaudeSdkError>;
    readonly abort: (sessionId: string) => Effect.Effect<void, HarnessSessionNotFound>;
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
}: ClaudeCodeAgentOptions = {}): Effect.Effect<
  ClaudeCodeAgent,
  never,
  Scope.Scope | FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const ownerScope = yield* Scope.Scope;
    // Locating the `claude` binary reads the filesystem. Bind the platform
    // services once here so the agent's own methods stay R-free; a machine
    // with no Claude Code install is a defect at this point, since the
    // adapter's availability check has already gated on it.
    // `Effect.provideService`, not `Effect.provide(Effect.context())`: the
    // latter captures the whole layer-build context — including the `Scope`
    // above — and wins the merge, so it would override a caller's scope.
    const fileSystem = yield* FileSystem.FileSystem;
    // Cached: the answer is fixed for the process, and both `buildSession` and
    // `listModels` ask, so an uncached Effect re-walks PATH on every session.
    const claudeExecutable = yield* Effect.cached(
      resolveClaudeExecutable({ env }).pipe(
        Effect.catchTag("ClaudeExecutableNotFound", (cause) =>
          Effect.die(
            new Error(
              "invariant: the claude executable vanished after the availability check gated on it",
              { cause },
            ),
          ),
        ),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
      ),
    );
    const sdkStderr = (line: string, annotations: Record<string, unknown>) => {
      const text = line.trimEnd();
      return text.length === 0
        ? Effect.void
        : Effect.logDebug(text).pipe(
            Effect.annotateLogs({
              event: "harness.stderr",
              harnessAgentId: "claude-code",
              ...annotations,
            }),
          );
    };
    const rootEffectContext = yield* Effect.context<never>();

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
            : Effect.fail(new HarnessSessionNotFound({ sessionId }));
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
      identity: Pick<sdk.Options, "sessionId" | "resume" | "cwd">,
    ): Effect.Effect<SessionState, ClaudeSdkError> =>
      Effect.gen(function* () {
        const sessionScope = yield* Scope.fork(ownerScope, "sequential");
        return yield* Effect.gen(function* () {
          // Active-turn steering must enqueue while holding turnPermit so a result
          // cannot cross the expectedTurnId check. Keep this queue non-blocking;
          // backpressure here would retain the permit and deadlock the result boundary.
          const input = yield* Queue.unbounded<sdk.SDKUserMessage, Cause.Done>();
          const output = yield* Queue.bounded<SessionOutput, Cause.Done | ClaudeSdkError>(
            SESSION_QUEUE_CAPACITY,
          );
          const permissionRequests = yield* Queue.dropping<ToolPermissionRequest, Cause.Done>(
            SESSION_QUEUE_CAPACITY,
          );
          const pendingPermissions = yield* Ref.make<ReadonlyMap<string, PendingToolPermission>>(
            new Map(),
          );
          const turnPermit = yield* Semaphore.make(1);
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
            // Permit bypass so a session can be switched to "bypassPermissions"
            // at runtime (setPermissionMode). This only enables the capability;
            // the active mode stays whatever `permissionMode` currently is.
            allowDangerouslySkipPermissions: true,
            stderr: (error) => {
              runCallback(sdkStderr(error, { harnessSessionId: sessionId }));
            },
            executable: process.execPath as "node",
            pathToClaudeCodeExecutable: yield* claudeExecutable,
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
            turnPermit,
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
                      ? yield* turnPermit.withPermit(
                          Ref.modify(turnState, (current) => {
                            if (current._tag !== "Active") return [undefined, current] as const;
                            return current.abandoned
                              ? [undefined, { _tag: "Idle" } as const]
                              : [current.token, { ...current, resultEnqueued: true } as const];
                          }),
                        )
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

    const resume = (
      sessionId: string,
      cwd?: string,
    ): Effect.Effect<SessionState, ClaudeAgentFailure> =>
      Effect.tryPromise<ClaudeSessionInfo, ClaudeSdkError>({
        try: () => getSessionInfo(sessionId),
        catch: (cause) => sdkError("get-session-info", cause),
      }).pipe(
        Effect.flatMap(
          (info): Effect.Effect<SessionState, SessionNotResumable | ClaudeSdkError> =>
            info
              ? buildSession(sessionId, {
                  resume: sessionId,
                  ...(cwd !== undefined ? { cwd } : {}),
                })
              : Effect.fail(new SessionNotResumable({ sessionId })),
        ),
      );

    // `cwd` is only consulted when the session has to be rebuilt (a resume): a
    // session already live in the map keeps the cwd it was opened with.
    const ensure = (
      sessionId: string,
      cwd?: string,
    ): Effect.Effect<SessionState, ClaudeAgentFailure> =>
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
              resume(sessionId, cwd).pipe(
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

    // A throwaway query that exists only to answer the supported-models control
    // request: `maxTurns: 0` with a prompt stream that never yields means the
    // CLI connects, replies, and does nothing else. Verified to leave no trace
    // on disk — no transcript under ~/.claude/projects, no history entry, so it
    // never pollutes `claude --resume`. It does run the user's SessionStart
    // hooks, which is the one cost worth knowing about.
    //
    // `cwd` is the whole reason this takes an argument. Together with
    // `settingSources` it is what makes the answer specific to the project the
    // user is about to work in: a project that sets
    // `env.ANTHROPIC_DEFAULT_SONNET_MODEL` (or runs through Bedrock/Vertex)
    // keeps the same ids but changes what they resolve to, so a catalog probed
    // in some other directory is a catalog for someone else's project.
    //
    // Two things *are* stripped, because a probe should cost as little as a
    // question. Medians of five runs on a developer machine:
    //
    //   4.3s  a session's own options
    //   2.7s  + mcpServers:{} + strictMcpConfig — otherwise the SDK merges the
    //         user's .mcp.json, settings and plugins and boots their entire MCP
    //         fleet to read a model list
    //   0.7s  + CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC — the CLI's documented
    //         master switch for autoupdater / telemetry / error reporting /
    //         feedback, none of which a process that lives 700ms and is thrown
    //         away should be doing
    //
    // Dropping `settingSources` to `[]` would save another ~0.3s and is exactly
    // the trade this must not make — it is the switch that turns the paragraph
    // above off. Both strippings that *were* taken were checked the same way:
    // diffing `supportedModels()` against a project carrying such a settings
    // file, byte-identical.
    const listModels = (cwd: string): Effect.Effect<sdk.ModelInfo[], ClaudeSdkError> =>
      Effect.acquireUseRelease(
        Effect.flatMap(claudeExecutable, (pathToClaudeCodeExecutable) =>
          Effect.try({
            try: () =>
              query({
                prompt: Stream.toAsyncIterable(Stream.never),
                options: {
                  cwd,
                  maxTurns: 0,
                  mcpServers: {},
                  strictMcpConfig: true,
                  settingSources: ["user", "project", "local"],
                  stderr: (error) => {
                    void Effect.runSyncExitWith(rootEffectContext)(
                      sdkStderr(error, { probe: "list-models" }),
                    );
                  },
                  executable: process.execPath as "node",
                  pathToClaudeCodeExecutable,
                  env: { ...env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
                },
              }),
            catch: (cause) => sdkError("list-models", cause),
          }),
        ),
        (probe) =>
          Effect.tryPromise({
            try: () => probe.supportedModels(),
            catch: (cause) => sdkError("list-models", cause),
          }),
        // Returning the generator is what tears the child process down; a probe
        // that leaked one per call would be a process leak per directory.
        (probe) => Effect.promise(() => probe.return()).pipe(Effect.ignore),
      );

    return {
      listModels,
      session: {
        create: (input) =>
          Effect.gen(function* () {
            const sessionId = uuid();
            yield* buildSession(sessionId, {
              sessionId,
              ...(input?.cwd !== undefined ? { cwd: input.cwd } : {}),
            });
            return { sessionId };
          }),
        resume: (input) => ensure(input.sessionId, input.cwd).pipe(Effect.as(input)),
        prompt: (input) =>
          Effect.gen(function* () {
            const session = yield* ensure(input.sessionId);
            const token = {};
            const turnId = uuid();
            yield* session.turnPermit.withPermit(
              Effect.gen(function* () {
                const current = yield* Ref.get(session.turnState);
                if (current._tag !== "Idle") {
                  return yield* new TurnAlreadyRunning({
                    sessionId: input.sessionId,
                    turnId: current.turnId,
                  });
                }
                yield* Ref.set(session.turnState, {
                  _tag: "Active",
                  turnId,
                  token,
                  abandoned: false,
                  resultEnqueued: false,
                });
                yield* drainQueue(session.output);
                const accepted = yield* Queue.offer(session.input, {
                  type: "user",
                  message: input.message,
                  parent_tool_use_id: null,
                  session_id: input.sessionId,
                });
                if (accepted) return;
                yield* Ref.set(session.turnState, { _tag: "Idle" });
                return yield* sdkError("prompt", new Error("Claude input is closed"));
              }),
            );

            return {
              turnId,
              output: streamFromQueueOne(session.output).pipe(
                Stream.filter((output) => output.token === token),
                Stream.map((output) => output.message),
                Stream.tap((message) =>
                  message.type === "result"
                    ? session.turnPermit.withPermit(
                        Ref.update(session.turnState, (current) =>
                          current._tag === "Active" && current.token === token
                            ? ({ _tag: "Idle" } as const)
                            : current,
                        ),
                      )
                    : Effect.void,
                ),
                Stream.takeUntil((message) => message.type === "result"),
                Stream.ensuring(
                  session.turnPermit.withPermit(
                    Ref.update(session.turnState, (current) => {
                      if (current._tag !== "Active" || current.token !== token) return current;
                      return current.resultEnqueued
                        ? ({ _tag: "Idle" } as const)
                        : ({ ...current, abandoned: true } as const);
                    }),
                  ),
                ),
              ),
            };
          }),
        steer: (input) =>
          Effect.gen(function* () {
            const session = yield* ensure(input.sessionId);
            yield* session.turnPermit.withPermit(
              Effect.gen(function* () {
                const current = yield* Ref.get(session.turnState);
                if (
                  current._tag !== "Active" ||
                  current.turnId !== input.expectedTurnId ||
                  current.abandoned ||
                  current.resultEnqueued
                ) {
                  return yield* new TurnAlreadyRunning({
                    sessionId: input.sessionId,
                    ...(current._tag === "Active" ? { turnId: current.turnId } : {}),
                  });
                }
                const accepted = yield* Queue.offer(session.input, {
                  type: "user",
                  message: input.message,
                  parent_tool_use_id: null,
                  session_id: input.sessionId,
                });
                if (!accepted) {
                  return yield* sdkError("steer", new Error("Claude input is closed"));
                }
              }),
            );
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
        // File-order read of the CLI's own transcript, NOT `sdk.getSessionMessages`
        // — see `parseTranscriptRecords` for why the SDK's branch walk loses
        // replies. `dir` narrows to the CLI's munged project directory first;
        // a miss falls back to scanning every project directory (session ids
        // are uuids, so the file name cannot collide).
        getSessionMessages: (sessionId, options) =>
          Effect.gen(function* () {
            const projectsRoot = path.join(os.homedir(), ".claude", "projects");
            const fileName = `${sessionId}.jsonl`;
            // Unreadable candidate = absent candidate: keep scanning; a session
            // with no transcript on disk yields empty history, not an error.
            // A miss is the common case — this scans every project directory —
            // so the read failure is only worth `debug`. It is still worth
            // *something*: an unreadable-but-present transcript and an absent
            // one are indistinguishable from the empty history both produce,
            // and only this line tells them apart.
            const readCandidate = (candidate: string) =>
              fileSystem.readFileString(candidate).pipe(
                Effect.map((content) => parseTranscriptRecords(content, sessionId)),
                Effect.tapError((cause) =>
                  Effect.logDebug("transcript candidate unreadable").pipe(
                    Effect.annotateLogs({
                      event: "harness.transcript.miss",
                      harnessAgentId: "claude-code",
                      harnessSessionId: sessionId,
                      candidate,
                      reason: cause.reason._tag,
                    }),
                  ),
                ),
                Effect.orElseSucceed(() => null),
              );
            if (options?.dir !== undefined) {
              const munged = options.dir.replace(/[^a-zA-Z0-9]/g, "-");
              const narrowed = yield* readCandidate(path.join(projectsRoot, munged, fileName));
              if (narrowed !== null) return narrowed;
            }
            // No `~/.claude/projects` at all: the CLI has never run here. That
            // is a legitimate empty history, not a failure — but a history
            // request for a session that supposedly exists says otherwise.
            const entries = yield* fileSystem.readDirectory(projectsRoot).pipe(
              Effect.tapError(() =>
                Effect.logDebug("no claude-code projects directory to scan").pipe(
                  Effect.annotateLogs({
                    event: "harness.transcript.no_root",
                    harnessAgentId: "claude-code",
                    projectsRoot,
                  }),
                ),
              ),
              Effect.orElseSucceed((): string[] => []),
            );
            for (const entry of entries) {
              const records = yield* readCandidate(path.join(projectsRoot, entry, fileName));
              if (records !== null) return records;
            }
            return [];
          }),
        setModel: (sessionId, model) =>
          callQuery(sessionId, "set-model", (sdkQuery) => sdkQuery.setModel(model)),
        setPermissionMode: (sessionId, mode) =>
          callQuery(sessionId, "set-permission-mode", (sdkQuery) =>
            sdkQuery.setPermissionMode(mode),
          ),
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
