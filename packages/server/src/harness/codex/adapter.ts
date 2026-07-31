import type { InputModality, PermissionMode, ModelInfo, ReasoningEffort } from "@vibest/contract";
import { InputModalitySchema, ReasoningEffortSchema } from "@vibest/contract";
import type { CodexUIMessageChunk } from "@vibest/contract/codex";
import type { AskForApproval, Model, SandboxPolicy } from "@vibest/contract/codex/protocol/v2";
import { Effect, Queue, Ref, Scope, Stream } from "effect";
import type * as Cause from "effect/Cause";

import {
  applyInitialSessionConfig,
  type HarnessAgentAdapter,
  type HarnessAgentSession,
  type SessionInfoResult,
  type UserInput,
} from "../adapter";
import {
  AgentOpenError,
  AgentOperationError,
  AgentRequestUnavailable,
  CapabilityProbeFailed,
  CodexRpcError,
  SessionClosed,
  SessionNotResumable,
  TurnAlreadyRunning,
} from "../errors";
import type { SessionEnvelopeDraft, SessionEvent } from "../events/framework";
import { findExecutable } from "../executable";
import { streamFromQueueOne } from "../queue-stream";
import type { CodexAgent } from "./agent";

const EVENT_QUEUE_CAPACITY = 1024;

const operationError = (sessionId: string, operation: string, cause: unknown) =>
  new AgentOperationError({ sessionId, operation, cause });

const toPromptText = (input: UserInput): string =>
  input.parts
    .map((part) =>
      part.type === "text"
        ? part.text
        : `i am current inspect target: ${part.data
            .map((target) => `@${target.file}:${target.line}:${target.column}`)
            .join(", ")}`,
    )
    .join("\n");

type CodexPermission = { approvalPolicy: AskForApproval; sandboxPolicy: SandboxPolicy };

const workspaceWrite: SandboxPolicy = {
  type: "workspaceWrite",
  writableRoots: [],
  networkAccess: false,
  excludeTmpdirEnvVar: false,
  excludeSlashTmp: false,
};

// Map vibest's permission vocabulary onto codex's approval policy + sandbox.
// Codex has no "plan" (it never produces a plan) — its read-only preset is a
// pure read-only sandbox, declared as our `read-only` member. The keys are the
// single source for the `permissionModes` declaration below.
const CODEX_PERMISSIONS = {
  "read-only": {
    approvalPolicy: "on-request",
    sandboxPolicy: { type: "readOnly", networkAccess: false },
  },
  ask: { approvalPolicy: "on-request", sandboxPolicy: workspaceWrite },
  full: { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } },
} as const satisfies Partial<Record<PermissionMode, CodexPermission>>;
const CODEX_PERMISSION_MODE_IDS = Object.keys(CODEX_PERMISSIONS) as ReadonlyArray<PermissionMode>;
const toCodexPermission = (mode: PermissionMode): CodexPermission | undefined =>
  (CODEX_PERMISSIONS as Partial<Record<PermissionMode, CodexPermission>>)[mode];

// Codex's wire enums are open strings; translate into our closed sets and drop
// what we don't recognise — a newer codex degrades to "one less option", never
// to an unrenderable value (harness-concept-ownership §3.4).
const toReasoningEffort = (value: string): ReasoningEffort | undefined =>
  (ReasoningEffortSchema.literals as ReadonlyArray<string>).includes(value)
    ? (value as ReasoningEffort)
    : undefined;
const toInputModality = (value: string): InputModality | undefined =>
  (InputModalitySchema.literals as ReadonlyArray<string>).includes(value)
    ? (value as InputModality)
    : undefined;

const toModelInfo = (model: Model): ModelInfo => {
  const reasoningEfforts = model.supportedReasoningEfforts
    .map((option) => toReasoningEffort(option.reasoningEffort))
    .filter((reasoningEffort): reasoningEffort is ReasoningEffort => reasoningEffort !== undefined);
  const defaultReasoningEffort = toReasoningEffort(model.defaultReasoningEffort);
  const modalities = model.inputModalities
    .map(toInputModality)
    .filter((modality): modality is InputModality => modality !== undefined);
  return {
    id: model.id,
    label: model.displayName,
    ...(reasoningEfforts.length > 0
      ? {
          reasoningEfforts,
          ...(defaultReasoningEffort !== undefined &&
          reasoningEfforts.includes(defaultReasoningEffort)
            ? { defaultReasoningEffort }
            : {}),
        }
      : {}),
    ...(modalities.length > 0 ? { modalities } : {}),
  };
};

const makeSession = (
  agent: CodexAgent,
  sessionId: string,
): Effect.Effect<HarnessAgentSession, never, Scope.Scope> =>
  Effect.gen(function* () {
    const scope = yield* Scope.Scope;
    const events = yield* Queue.bounded<SessionEnvelopeDraft, Cause.Done | AgentOperationError>(
      EVENT_QUEUE_CAPACITY,
    );
    const cursor = yield* Ref.make(0);
    const closed = yield* Ref.make(false);
    const activeTurn = yield* Ref.make<string | undefined>(undefined);
    // Codex has no session-wide permission call; it takes an approval policy +
    // sandbox per turn. We hold the current mode here and apply it on each turn.
    const permissionMode = yield* Ref.make<CodexPermission | undefined>(undefined);
    // Same story for the model: `thread/start` fixes one, but `turn/start`
    // overrides it for that turn and every turn after. Holding it here is what
    // lets create-time selection work at all — applyInitialSessionConfig calls
    // setModel before the first prompt, and that first turn carries it.
    const model = yield* Ref.make<string | undefined>(undefined);
    // ReasoningEffort rides `turn/start` the same way. Cleared on setModel: an reasoningEffort
    // picked for one model must not survive onto another — no override means
    // codex applies the new model's own default.
    const reasoningEffort = yield* Ref.make<ReasoningEffort | undefined>(undefined);

    const emit = (body: CodexUIMessageChunk | SessionEvent) =>
      Queue.offer(events, { harnessAgentId: "codex", sessionId, body }).pipe(
        Effect.flatMap((accepted) =>
          accepted
            ? Ref.update(cursor, (current) => current + 1)
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

    const interrupt: HarnessAgentSession["interrupt"] = Effect.gen(function* () {
      if (yield* Ref.get(closed)) return yield* new SessionClosed({ sessionId });
      yield* agent.session
        .interrupt(sessionId)
        .pipe(Effect.mapError((cause) => operationError(sessionId, "interrupt", cause)));
    });

    yield* Scope.addFinalizer(scope, close);
    yield* agent.session.awaitTermination(sessionId).pipe(
      Effect.catch((cause) => crash(cause)),
      Effect.forkIn(scope),
    );
    yield* Stream.runForEach(agent.session.requestPermission(sessionId), (request) =>
      emit({ type: "session.request.asked", sessionId, request }),
    ).pipe(Effect.catch(crash), Effect.forkIn(scope));

    return {
      sessionId,
      harnessAgentId: "codex",
      events: streamFromQueueOne(events),
      prompt: (input) =>
        Effect.gen(function* () {
          if (yield* Ref.get(closed)) return yield* new SessionClosed({ sessionId });
          const permission = yield* Ref.get(permissionMode);
          const selectedModel = yield* Ref.get(model);
          const selectedEffort = yield* Ref.get(reasoningEffort);
          const prompt = yield* agent.session
            .prompt({
              sessionId,
              text: toPromptText(input),
              ...permission,
              ...(selectedModel ? { model: selectedModel } : {}),
              ...(selectedEffort ? { reasoningEffort: selectedEffort } : {}),
            })
            .pipe(
              Effect.mapError((cause) =>
                cause instanceof TurnAlreadyRunning
                  ? cause
                  : operationError(sessionId, "prompt", cause),
              ),
            );
          const receipt = {
            turnId: prompt.turnId,
            cursor: yield* Ref.get(cursor),
            started: prompt.started,
          };
          if (prompt.started) {
            yield* Ref.set(activeTurn, prompt.turnId);
            yield* emit({ type: "session.turn.started", sessionId, turnId: prompt.turnId });
          }

          const finished = yield* Ref.make(false);
          const pump = Stream.runForEach(prompt.output, (chunk) =>
            emit(chunk).pipe(
              Effect.andThen(
                chunk.type === "finish"
                  ? Ref.set(finished, true).pipe(
                      Effect.andThen(
                        emit({
                          type: "session.turn.ended",
                          sessionId,
                          turnId: prompt.turnId,
                          outcome: "completed",
                        }).pipe(
                          Effect.andThen(
                            Ref.update(activeTurn, (current) =>
                              current === prompt.turnId ? undefined : current,
                            ),
                          ),
                        ),
                      ),
                    )
                  : Effect.void,
              ),
            ),
          ).pipe(
            Effect.flatMap(() => Ref.get(finished)),
            Effect.flatMap((didFinish) =>
              prompt.started && !didFinish
                ? crash(new Error("Codex turn ended without a finish event"))
                : Effect.void,
            ),
            Effect.catch(crash),
          );
          yield* Effect.forkIn(pump, scope);
          return receipt;
        }),
      // Stored, not sent: codex has no standalone set-model call, the override
      // rides on the next `turn/start`. So a mid-session switch takes effect
      // from the next turn — unlike claude-code, where it is immediate.
      // Switching the model also clears the reasoningEffort override, so the next turn
      // runs on the new model's own default reasoningEffort.
      setModel: (next) =>
        Ref.set(model, next).pipe(Effect.andThen(Ref.set(reasoningEffort, undefined))),
      setReasoningEffort: (next) => Ref.set(reasoningEffort, next),
      setPermissionMode: (mode) =>
        Effect.gen(function* () {
          const native = toCodexPermission(mode);
          if (!native)
            return yield* Effect.fail(
              operationError(
                sessionId,
                "set-permission-mode",
                new Error(`unknown permission mode: ${mode}`),
              ),
            );
          yield* Ref.set(permissionMode, native);
        }),
      interrupt,
      respondToAgentRequest: (requestId, response) =>
        agent.session.respondPermission(sessionId, requestId, response).pipe(
          Effect.mapError((cause) =>
            cause instanceof AgentRequestUnavailable
              ? cause
              : operationError(sessionId, "respond-to-request", cause),
          ),
          Effect.andThen(emit({ type: "session.request.replied", sessionId, requestId })),
        ),
      getCapabilities: Effect.succeed({
        supportsResume: true,
        supportsSteering: true,
        supportsPermissions: true,
      }),
      close,
    } satisfies HarnessAgentSession;
  });

export const makeCodexAdapter = (
  agent: CodexAgent,
  options: { readonly executablePath?: string } = {},
): HarnessAgentAdapter => ({
  id: "codex",
  descriptor: { id: "codex", name: "Codex" },
  permissionModes: CODEX_PERMISSION_MODE_IDS,
  // Lower than claude-code's on purpose: codex's "full" is
  // `approvalPolicy: "never"` *plus* `dangerFullAccess`, i.e. no sandbox at
  // all — not a default anyone should land on without asking for it.
  defaultPermissionMode: "ask",
  // `cwd` is ignored, not forgotten: codex's `model/list` takes no directory —
  // it answers for the whole app-server. Taking the argument anyway keeps the
  // seam uniform, so callers never branch on which harness cares, and the day
  // codex grows per-project config this is a one-line change here.
  probeModels: (_cwd) =>
    agent.listModels.pipe(
      // The catalog's `isDefault` flag is deliberately not forwarded: it is
      // the API's suggestion, while an unconfigured session actually runs
      // whatever the user's own config.toml says — which is not probeable.
      // The default is expressed by absence, not by a marker.
      Effect.map((models) => models.map(toModelInfo)),
      Effect.mapError((cause) => new CapabilityProbeFailed({ harnessAgentId: "codex", cause })),
    ),
  // A PATH lookup, not a spawn: negotiate has to stay cheap on machines where
  // codex simply isn't installed, which is the common case.
  checkAvailability: Effect.sync(() =>
    findExecutable(options.executablePath ?? "codex")
      ? { available: true }
      : { available: false, reason: "Codex was not found on PATH." },
  ),
  open: (input) =>
    agent.session.create({ cwd: input.cwd }).pipe(
      Effect.mapError((cause) => new AgentOpenError({ harnessAgentId: "codex", cause })),
      Effect.flatMap(({ sessionId }) => makeSession(agent, sessionId)),
      Effect.tap((session) => applyInitialSessionConfig(session, input)),
    ),
  resume: (input) =>
    agent.session.resume({ sessionId: input.sessionId, cwd: input.cwd }).pipe(
      Effect.mapError((cause) =>
        cause instanceof SessionNotResumable
          ? cause
          : new AgentOpenError({ harnessAgentId: "codex", cause }),
      ),
      Effect.flatMap(({ sessionId }) => makeSession(agent, sessionId)),
    ),
  getSessionInfo: (harnessSessionId) =>
    agent.session.read({ sessionId: harnessSessionId }).pipe(
      Effect.map((thread): SessionInfoResult => {
        const title = thread.name ?? thread.preview;
        return {
          _tag: "found",
          info: {
            ...(title ? { title } : {}),
            // Codex reports thread timestamps in seconds; callers expect ms.
            updatedAt: thread.updatedAt * 1000,
          },
        };
      }),
      // A well-formed "not found" reply means the thread's history is gone;
      // any other transport failure is a real error the caller degrades.
      Effect.catch((cause) =>
        cause instanceof CodexRpcError
          ? Effect.succeed<SessionInfoResult>({ _tag: "missing" })
          : Effect.fail(operationError(harnessSessionId, "get-session-info", cause)),
      ),
    ),
});
