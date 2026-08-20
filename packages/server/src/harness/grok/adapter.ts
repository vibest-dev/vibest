import type { ModelInfo, PermissionMode } from "@vibest/contract";
import { Effect, Queue, Ref, Scope, Stream } from "effect";
import type * as Cause from "effect/Cause";

import {
  type HarnessAgentAdapter,
  type HarnessAgentRuntime,
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
import type { SessionEnvelopeDraft } from "../events/framework";
import { streamFromQueueOne } from "../queue-stream";
import type { GrokAgent } from "./agent";
import { checkGrokAvailability } from "./executable";
import type { ModelInfoNative } from "./protocol";

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

const GROK_PERMISSION_MODES = {
  ask: "default",
  full: "bypassPermissions",
} as const satisfies Partial<Record<PermissionMode, string>>;
const GROK_PERMISSION_MODE_IDS = Object.keys(
  GROK_PERMISSION_MODES,
) as ReadonlyArray<PermissionMode>;
const toGrokPermissionMode = (mode: PermissionMode): string | undefined =>
  GROK_PERMISSION_MODES[mode as keyof typeof GROK_PERMISSION_MODES];

const toModelInfo = (model: ModelInfoNative): ModelInfo => ({
  id: model.modelId,
  ...(model.name !== undefined ? { label: model.name } : {}),
});

const makeRuntime = (
  agent: GrokAgent,
  sessionId: string,
): Effect.Effect<HarnessAgentRuntime, never, Scope.Scope> =>
  Effect.gen(function* () {
    const scope = yield* Scope.Scope;
    const events = yield* Queue.bounded<SessionEnvelopeDraft, Cause.Done | AgentOperationError>(
      EVENT_QUEUE_CAPACITY,
    );
    const cursor = yield* Ref.make(0);
    const closed = yield* Ref.make(false);
    const activeTurn = yield* Ref.make<string | undefined>(undefined);

    const emit = (body: SessionEnvelopeDraft["body"]) =>
      Queue.offer(events, { harnessAgentId: "grok", sessionId, body }).pipe(
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

    const interrupt: HarnessAgentRuntime["interrupt"] = Effect.gen(function* () {
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
      harnessAgentId: "grok",
      events: streamFromQueueOne(events),
      prompt: (input) =>
        Effect.gen(function* () {
          if (yield* Ref.get(closed)) return yield* new SessionClosed({ sessionId });
          const prompt = yield* agent.session
            .prompt({ sessionId, text: toPromptText(input) })
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
                  ? prompt.completion.pipe(
                      Effect.flatMap((completion) =>
                        emit({
                          type: "session.turn.ended",
                          sessionId,
                          turnId: prompt.turnId,
                          outcome: completion.outcome,
                          ...(completion.usage ? { usage: completion.usage } : {}),
                        }),
                      ),
                      Effect.andThen(Ref.set(finished, true)),
                      Effect.andThen(
                        Ref.update(activeTurn, (current) =>
                          current === prompt.turnId ? undefined : current,
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
                ? crash(new Error("Grok turn ended without a finish event"))
                : Effect.void,
            ),
            Effect.catch(crash),
          );
          yield* Effect.forkIn(pump, scope);
          return receipt;
        }),
      setModel: (model) =>
        Effect.gen(function* () {
          if (yield* Ref.get(closed)) return yield* new SessionClosed({ sessionId });
          yield* agent.session
            .setModel(sessionId, model)
            .pipe(Effect.mapError((cause) => operationError(sessionId, "set-model", cause)));
        }),
      setReasoningEffort: () => Effect.void,
      setPermissionMode: (mode) =>
        Effect.gen(function* () {
          if (yield* Ref.get(closed)) return yield* new SessionClosed({ sessionId });
          const native = toGrokPermissionMode(mode);
          if (!native) {
            return yield* Effect.fail(
              operationError(
                sessionId,
                "set-permission-mode",
                new Error(`unknown permission mode: ${mode}`),
              ),
            );
          }
          yield* agent.session
            .setPermissionMode(sessionId, native)
            .pipe(
              Effect.mapError((cause) => operationError(sessionId, "set-permission-mode", cause)),
            );
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
        supportsSteering: false,
        supportsPermissions: true,
      }),
      close,
    } satisfies HarnessAgentRuntime;
  });

export const makeGrokAdapter = (
  agent: GrokAgent,
  options: { readonly executablePath?: string } = {},
): HarnessAgentAdapter => ({
  id: "grok",
  descriptor: { id: "grok", name: "Grok" },
  permissionModes: GROK_PERMISSION_MODE_IDS,
  defaultPermissionMode: "ask",
  probeModels: (_cwd) =>
    agent.listModels.pipe(
      Effect.map((result) => (result.availableModels ?? []).map(toModelInfo)),
      Effect.mapError((cause) => new CapabilityProbeFailed({ harnessAgentId: "grok", cause })),
    ),
  checkAvailability: checkGrokAvailability(
    options.executablePath
      ? { env: { ...process.env, VIBEST_GROK_EXECUTABLE: options.executablePath } }
      : {},
  ),
  open: (input) =>
    agent.session.create({ cwd: input.cwd }).pipe(
      Effect.mapError((cause) => new AgentOpenError({ harnessAgentId: "grok", cause })),
      Effect.flatMap(({ sessionId }) => makeRuntime(agent, sessionId)),
    ),
  resume: (input) => {
    const cwd = input.cwd;
    if (cwd === undefined) {
      return Effect.fail(
        new AgentOpenError({
          harnessAgentId: "grok",
          cause: new Error("resume requires cwd"),
        }),
      );
    }
    return agent.session.resume({ sessionId: input.sessionId, cwd }).pipe(
      Effect.mapError((cause) =>
        cause instanceof SessionNotResumable
          ? cause
          : new AgentOpenError({ harnessAgentId: "grok", cause }),
      ),
      Effect.flatMap(({ sessionId }) => makeRuntime(agent, sessionId)),
    );
  },
  getSessionInfo: () => Effect.succeed<SessionInfoResult>({ _tag: "unsupported" }),
});
