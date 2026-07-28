import type * as sdk from "@anthropic-ai/claude-agent-sdk";
import type { PermissionMode } from "@vibest/contract";
import type { SessionEvent } from "@vibest/harness";
import type { ClaudeCodeUIMessageChunk, SessionEnvelopeDraft } from "@vibest/harness";
import type { AgentRequest, AgentResponse } from "@vibest/harness";
import { toSessionEvent } from "@vibest/harness/claude-code";
import { createTransform } from "@vibest/harness/claude-code";
import { Effect, Queue, Ref, Scope, Stream } from "effect";
import type * as Cause from "effect/Cause";

import {
  applyInitialSessionConfig,
  type HarnessAgentAdapter,
  type HarnessAgentSession,
  type SessionCapabilities,
  type SessionInfoResult,
  type UserInput,
} from "../adapter";
import {
  AgentOpenError,
  AgentOperationError,
  AgentRequestUnavailable,
  CapabilityProbeFailed,
  SessionClosed,
  SessionNotResumable,
  TurnAlreadyRunning,
} from "../errors";
import { streamFromQueueOne } from "../queue-stream";
import type { ClaudeCodeAgent, ToolPermissionRequest } from "./agent";
import { checkClaudeAvailability } from "./executable";

const EVENT_QUEUE_CAPACITY = 1024;

const operationError = (sessionId: string, operation: string, cause: unknown) =>
  new AgentOperationError({ sessionId, operation, cause });

// Map vibest's permission vocabulary onto the SDK's native enum. The keys are
// this adapter's declared subset — the single source for both the mapping and
// the `permissionModes` declaration below, so the two can't drift.
const CLAUDE_PERMISSION_MODES = {
  plan: "plan",
  ask: "default",
  acceptEdits: "acceptEdits",
  full: "bypassPermissions",
} as const satisfies Partial<Record<PermissionMode, sdk.PermissionMode>>;
const CLAUDE_PERMISSION_MODE_IDS = Object.keys(
  CLAUDE_PERMISSION_MODES,
) as ReadonlyArray<PermissionMode>;
const toClaudePermissionMode = (mode: PermissionMode): sdk.PermissionMode | undefined =>
  (CLAUDE_PERMISSION_MODES as Partial<Record<PermissionMode, sdk.PermissionMode>>)[mode];

const toClaudeMessage = (input: UserInput): sdk.SDKUserMessage["message"] => ({
  role: "user",
  content: input.parts.map((part) =>
    part.type === "text"
      ? { type: "text" as const, text: part.text }
      : {
          type: "text" as const,
          text: `i am current inspect target: ${part.data
            .map((target) => `@${target.file}:${target.line}:${target.column}`)
            .join(", ")}`,
        },
  ),
});

const toAgentRequest = (request: ToolPermissionRequest): AgentRequest => {
  if (request.toolName === "AskUserQuestion") {
    const rawQuestions = Array.isArray((request.input as { questions?: unknown }).questions)
      ? ((request.input as { questions: ReadonlyArray<Record<string, unknown>> }).questions ?? [])
      : [];
    return {
      type: "question",
      id: request.requestId,
      harnessAgentId: "claude-code",
      questions: rawQuestions.map((raw) => {
        const rawOptions = Array.isArray(raw.options)
          ? (raw.options as ReadonlyArray<Record<string, unknown>>)
          : [];
        return {
          id: String(raw.question),
          question: String(raw.question),
          kind: rawOptions.length > 0 ? ("choice" as const) : ("freeText" as const),
          ...(raw.header !== undefined ? { header: String(raw.header) } : {}),
          ...(typeof raw.multiSelect === "boolean" ? { multiSelect: raw.multiSelect } : {}),
          ...(rawOptions.length > 0
            ? {
                options: rawOptions.map((option) => ({
                  label: String(option.label),
                  ...(option.description !== undefined
                    ? { description: String(option.description) }
                    : {}),
                })),
              }
            : {}),
        };
      }),
      native: request.input,
    };
  }
  if (request.toolName === "ExitPlanMode") {
    return {
      type: "plan",
      id: request.requestId,
      harnessAgentId: "claude-code",
      plan: String((request.input as { plan?: unknown }).plan ?? ""),
      native: request.input,
    };
  }
  return {
    type: "tool",
    id: request.requestId,
    harnessAgentId: "claude-code",
    toolName: request.toolName,
    input: request.input,
    actions: [
      { id: "allow", label: "Allow", behavior: "allow", variant: "primary" },
      ...(request.suggestions?.length
        ? [
            {
              id: "grant:session",
              label: "Allow for this session",
              behavior: "allow" as const,
              grant: { type: "session" as const },
            },
          ]
        : []),
      { id: "deny", label: "Deny", behavior: "deny" },
    ],
    native: request.suggestions,
  };
};

const toPermissionResult = (
  request: ToolPermissionRequest,
  response: AgentResponse,
): sdk.PermissionResult => {
  if (response.type === "question") {
    if (response.answers.length === 0) return { behavior: "deny", message: "Dismissed" };
    const answers: Record<string, string> = {};
    for (const answer of response.answers) {
      answers[answer.questionId] = [...answer.values, ...(answer.other ? [answer.other] : [])].join(
        ", ",
      );
    }
    return { behavior: "allow", updatedInput: { ...request.input, answers } };
  }
  if (response.behavior === "deny") {
    return {
      behavior: "deny",
      message: response.message ?? "User denied the permission request",
      interrupt: response.interrupt,
    };
  }
  const result: sdk.PermissionResult = { behavior: "allow", updatedInput: request.input };
  if (response.type === "plan" && response.mode) {
    result.updatedPermissions = [{ type: "setMode", mode: response.mode, destination: "session" }];
  }
  if (response.type === "tool" && response.grant?.type === "session" && request.suggestions) {
    result.updatedPermissions = request.suggestions.map((suggestion) =>
      "destination" in suggestion ? { ...suggestion, destination: "session" as const } : suggestion,
    );
  }
  return result;
};

const makeSession = (
  agent: ClaudeCodeAgent,
  sessionId: string,
): Effect.Effect<HarnessAgentSession, never, Scope.Scope> =>
  Effect.gen(function* () {
    const scope = yield* Scope.Scope;
    const events = yield* Queue.bounded<SessionEnvelopeDraft, Cause.Done | AgentOperationError>(
      EVENT_QUEUE_CAPACITY,
    );
    const closed = yield* Ref.make(false);
    const activeTurn = yield* Ref.make<string | undefined>(undefined);
    const pendingPermissions = yield* Ref.make<ReadonlyMap<string, ToolPermissionRequest>>(
      new Map(),
    );
    const transform = createTransform();

    const emit = (body: ClaudeCodeUIMessageChunk | SessionEvent) =>
      Queue.offer(events, { harnessAgentId: "claude-code", sessionId, body }).pipe(
        Effect.flatMap((accepted) =>
          accepted
            ? Effect.void
            : Effect.fail(
                operationError(sessionId, "publish-event", new Error("Event queue closed")),
              ),
        ),
      );

    const crash = (cause: unknown) =>
      Ref.getAndSet(closed, true).pipe(
        Effect.flatMap((alreadyClosed) =>
          alreadyClosed
            ? Effect.void
            : Ref.getAndSet(activeTurn, undefined).pipe(
                Effect.flatMap((turnId) =>
                  emit({ type: "session.crashed", sessionId, reason: String(cause) }).pipe(
                    Effect.andThen(
                      turnId
                        ? emit({
                            type: "session.turn.ended",
                            sessionId,
                            turnId,
                            outcome: "failed",
                            error: { message: String(cause), category: "unknown" },
                          })
                        : Effect.void,
                    ),
                  ),
                ),
                Effect.catch(() => Effect.void),
                Effect.andThen(
                  agent.session.abort(sessionId).pipe(Effect.catch(() => Effect.void)),
                ),
                Effect.andThen(Queue.end(events)),
                Effect.asVoid,
              ),
        ),
      );

    const close = Ref.getAndSet(closed, true).pipe(
      Effect.flatMap((alreadyClosed) =>
        alreadyClosed
          ? Effect.void
          : Ref.getAndSet(activeTurn, undefined).pipe(
              Effect.flatMap((turnId) =>
                turnId
                  ? emit({
                      type: "session.turn.ended",
                      sessionId,
                      turnId,
                      outcome: "canceled",
                    })
                  : Effect.void,
              ),
              Effect.catch(() => Effect.void),
              Effect.andThen(agent.session.abort(sessionId).pipe(Effect.catch(() => Effect.void))),
              Effect.andThen(Queue.end(events)),
              Effect.asVoid,
            ),
      ),
    );

    yield* Scope.addFinalizer(scope, close);
    yield* agent.session.awaitTermination(sessionId).pipe(
      Effect.catch((cause) => crash(cause)),
      Effect.forkIn(scope),
    );
    yield* Stream.runForEach(agent.session.requestPermission(sessionId), (nativeRequest) =>
      Ref.update(pendingPermissions, (current) =>
        new Map(current).set(nativeRequest.requestId, nativeRequest),
      ).pipe(
        Effect.andThen(
          emit({
            type: "session.request.asked",
            sessionId,
            request: toAgentRequest(nativeRequest),
          }),
        ),
      ),
    ).pipe(Effect.catch(crash), Effect.forkIn(scope));

    const interrupt: HarnessAgentSession["interrupt"] = Effect.gen(function* () {
      if (yield* Ref.get(closed)) return yield* new SessionClosed({ sessionId });
      yield* agent.session
        .interrupt(sessionId)
        .pipe(Effect.mapError((cause) => operationError(sessionId, "interrupt", cause)));
    });

    const setModel: HarnessAgentSession["setModel"] = (model) =>
      Effect.gen(function* () {
        if (yield* Ref.get(closed)) return yield* new SessionClosed({ sessionId });
        yield* agent.session
          .setModel(sessionId, model)
          .pipe(Effect.mapError((cause) => operationError(sessionId, "set-model", cause)));
      });

    const setPermissionMode: HarnessAgentSession["setPermissionMode"] = (mode) =>
      Effect.gen(function* () {
        if (yield* Ref.get(closed)) return yield* new SessionClosed({ sessionId });
        const native = toClaudePermissionMode(mode);
        if (!native)
          return yield* Effect.fail(
            operationError(
              sessionId,
              "set-permission-mode",
              new Error(`unknown permission mode: ${mode}`),
            ),
          );
        yield* agent.session
          .setPermissionMode(sessionId, native)
          .pipe(
            Effect.mapError((cause) => operationError(sessionId, "set-permission-mode", cause)),
          );
      });

    const getCapabilities: HarnessAgentSession["getCapabilities"] = Effect.gen(function* () {
      const [commands, models, mcpServers] = yield* Effect.all(
        [
          agent.session.getSupportedCommands(sessionId),
          agent.session.getSupportedModels(sessionId),
          agent.session.getMcpServers(sessionId),
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.mapError((cause) => operationError(sessionId, "get-capabilities", cause)));

      return {
        commands: commands.map((command) => ({
          name: command.name,
          description: command.description,
        })),
        models: models.map((model) => ({ id: model.value, name: model.displayName })),
        mcpServers: mcpServers.map((server) => ({ name: server.name, status: server.status })),
        supportsResume: true,
        supportsSteering: false,
        supportsPermissions: true,
      } satisfies SessionCapabilities;
    });

    // The SDK has no runtime reasoningEffort control (only a query-start option), so
    // this adapter declares no `reasoningEfforts` traits on its models and the setter
    // is a defensive no-op — the client renders no reasoningEffort control for it.
    const setReasoningEffort: HarnessAgentSession["setReasoningEffort"] = () => Effect.void;

    return {
      sessionId,
      harnessAgentId: "claude-code",
      events: streamFromQueueOne(events),
      prompt: (input) =>
        Effect.gen(function* () {
          if (yield* Ref.get(closed)) return yield* new SessionClosed({ sessionId });
          const prompt = yield* agent.session
            .prompt({ sessionId, message: toClaudeMessage(input) })
            .pipe(
              Effect.mapError((cause) =>
                cause instanceof TurnAlreadyRunning
                  ? cause
                  : operationError(sessionId, "prompt", cause),
              ),
            );
          const receipt = { turnId: prompt.turnId };
          yield* Ref.set(activeTurn, prompt.turnId);
          yield* emit({ type: "session.turn.started", sessionId, turnId: prompt.turnId });

          const ended = yield* Ref.make(false);
          const pump = Stream.runForEach(prompt.output, (message) =>
            Effect.gen(function* () {
              for (const chunk of transform(message)) yield* emit(chunk);
              const event = toSessionEvent(message, {
                sessionId,
                activeTurnId: prompt.turnId,
                nextTurnId: () => prompt.turnId,
              });
              if (event?.type === "session.turn.ended") {
                yield* emit(event);
                yield* Ref.set(ended, true);
                yield* Ref.update(activeTurn, (current) =>
                  current === prompt.turnId ? undefined : current,
                );
              }
            }),
          ).pipe(
            Effect.flatMap(() => Ref.get(ended)),
            Effect.flatMap((didEnd) =>
              didEnd ? Effect.void : crash(new Error("Claude turn ended without a result event")),
            ),
            Effect.catch(crash),
          );
          yield* Effect.forkIn(pump, scope);
          return receipt;
        }),
      setModel,
      setReasoningEffort,
      setPermissionMode,
      interrupt,
      respondToAgentRequest: (requestId, response) =>
        Ref.get(pendingPermissions).pipe(
          Effect.flatMap((pending) => {
            const request = pending.get(requestId);
            return request
              ? Effect.succeed(request)
              : Effect.fail(new AgentRequestUnavailable({ sessionId, requestId }));
          }),
          Effect.flatMap((request) =>
            agent.session.respondPermission(
              sessionId,
              requestId,
              toPermissionResult(request, response),
            ),
          ),
          Effect.mapError((cause) =>
            cause instanceof AgentRequestUnavailable
              ? cause
              : operationError(sessionId, "respond-to-request", cause),
          ),
          Effect.andThen(
            Ref.update(pendingPermissions, (current) => {
              const next = new Map(current);
              next.delete(requestId);
              return next;
            }),
          ),
          Effect.andThen(emit({ type: "session.request.replied", sessionId, requestId })),
        ),
      getCapabilities,
      close,
    } satisfies HarnessAgentSession;
  });

export const makeClaudeCodeAdapter = (agent: ClaudeCodeAgent): HarnessAgentAdapter => ({
  id: "claude-code",
  descriptor: { id: "claude-code", name: "Claude Code" },
  permissionModes: CLAUDE_PERMISSION_MODE_IDS,
  // Keeps today's behaviour: the first turn shouldn't be gated on approvals.
  // Codex defaults lower because its "full" also drops the sandbox; this one
  // only bypasses the prompts.
  defaultPermissionMode: "full",
  probeModels: (cwd) =>
    agent.listModels(cwd).pipe(
      // No `reasoningEfforts` traits on purpose: the SDK exposes the levels in its
      // catalogue but offers no runtime call to apply one, and declaring a
      // capability we cannot honour would render a dead control. The SDK's
      // "Default (recommended)" row passes through as an ordinary pickable
      // model — it is an option whose meaning is "let the CLI decide", not a
      // preselection marker.
      Effect.map((models) =>
        models.map((model) => ({ id: model.value, label: model.displayName })),
      ),
      Effect.mapError(
        (cause) => new CapabilityProbeFailed({ harnessAgentId: "claude-code", cause }),
      ),
    ),
  // Present AND new enough: a resolvable binary that is older than the version
  // the SDK bundles reports as unavailable, so a too-old install fails fast
  // (AgentUnavailable → UNSUPPORTED) instead of launching against a CLI whose
  // wire protocol the harness types no longer match.
  checkAvailability: Effect.promise(() => checkClaudeAvailability()),
  open: (input) =>
    agent.session.create({ cwd: input.cwd }).pipe(
      Effect.mapError((cause) => new AgentOpenError({ harnessAgentId: "claude-code", cause })),
      Effect.flatMap(({ sessionId }) => makeSession(agent, sessionId)),
      Effect.tap((session) => applyInitialSessionConfig(session, input)),
    ),
  resume: (input) =>
    agent.session.resume({ sessionId: input.sessionId, cwd: input.cwd }).pipe(
      Effect.mapError((cause) =>
        cause instanceof SessionNotResumable
          ? cause
          : new AgentOpenError({ harnessAgentId: "claude-code", cause }),
      ),
      Effect.flatMap(({ sessionId }) => makeSession(agent, sessionId)),
    ),
  getSessionInfo: (harnessSessionId, cwd) =>
    agent.session.getSessionInfo(harnessSessionId, cwd ? { dir: cwd } : undefined).pipe(
      // The SDK buckets a session under the cwd it ran in. That is the project's
      // path for anything opened since `open`/`resume` started forwarding cwd —
      // the narrowed lookup, one directory. Sessions created before that ran in
      // the server's cwd and would now report a titleless `missing`, so fall
      // back to the unnarrowed search (every project dir) only when the fast
      // path misses. The session id is a uuid, so it can't collide.
      Effect.flatMap((info) =>
        info !== undefined || cwd === undefined
          ? Effect.succeed(info)
          : agent.session.getSessionInfo(harnessSessionId),
      ),
      Effect.mapError((cause) => operationError(harnessSessionId, "get-session-info", cause)),
      Effect.map(
        (info): SessionInfoResult =>
          info
            ? {
                _tag: "found",
                // customTitle (user /rename) wins over the auto summary; both fall
                // back to undefined title if empty.
                info: { title: info.customTitle ?? info.summary, updatedAt: info.lastModified },
              }
            : { _tag: "missing" },
      ),
    ),
});
