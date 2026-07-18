import { Effect, Queue, Ref, Scope, Stream } from "effect";
import type * as Cause from "effect/Cause";

import type { SessionEvent } from "../../event-manifest";
import {
  applyInitialSessionConfig,
  type HarnessAgentAdapter,
  type HarnessAgentSession,
  type PermissionMode,
  type UserInput,
} from "../../runtime/adapter";
import {
  AgentOpenError,
  AgentOperationError,
  AgentRequestUnavailable,
  SessionClosed,
  SessionNotResumable,
  TurnAlreadyRunning,
} from "../../runtime/errors";
import { streamFromQueueOne } from "../../runtime/queue-stream";
import type { CodexUIMessageChunk, SessionEnvelopeDraft } from "../../types/envelope";
import type { CodexAgent } from "../agent";
import type { AskForApproval, SandboxPolicy } from "../protocol/v2";

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

// Map the harness-agnostic permission mode onto Codex's approval policy +
// sandbox. Codex has no native "plan" mode; a read-only sandbox is the closest
// no-mutations equivalent.
const toCodexPermission = (
  mode: PermissionMode,
): { approvalPolicy: AskForApproval; sandboxPolicy: SandboxPolicy } => {
  const workspaceWrite: SandboxPolicy = {
    type: "workspaceWrite",
    writableRoots: [],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
  switch (mode) {
    case "default":
      return { approvalPolicy: "on-request", sandboxPolicy: workspaceWrite };
    case "acceptEdits":
      return { approvalPolicy: "on-failure", sandboxPolicy: workspaceWrite };
    case "plan":
      return {
        approvalPolicy: "on-request",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
      };
    case "bypass":
      return { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } };
  }
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
    const permissionMode = yield* Ref.make<PermissionMode | undefined>(undefined);

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
          const mode = yield* Ref.get(permissionMode);
          const permission = mode ? toCodexPermission(mode) : undefined;
          const prompt = yield* agent.session
            .prompt({ sessionId, text: toPromptText(input), ...permission })
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
      // Codex fixes its model at thread start; there's no runtime switch, so we
      // accept the call and no-op rather than fail the caller.
      setModel: () => Effect.void,
      setPermissionMode: (mode) => Ref.set(permissionMode, mode),
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

export const makeCodexAdapter = (agent: CodexAgent): HarnessAgentAdapter => ({
  id: "codex",
  descriptor: { id: "codex", name: "Codex" },
  capabilities: Effect.succeed({
    permissionModes: [
      // Codex has no "plan" (it never produces a plan) — its read-only preset
      // is a pure read-only sandbox, declared under its own id.
      { id: "read-only", label: "Read only" },
      { id: "ask", label: "Ask" },
      { id: "full", label: "Full access" },
    ],
  }),
  checkAvailability: Effect.succeed({ available: true }),
  open: (input) =>
    agent.session.create({ workspacePath: input.workspacePath }).pipe(
      Effect.mapError((cause) => new AgentOpenError({ harnessAgentId: "codex", cause })),
      Effect.flatMap(({ sessionId }) => makeSession(agent, sessionId)),
      Effect.tap((session) => applyInitialSessionConfig(session, input)),
    ),
  resume: (input) =>
    agent.session.resume({ sessionId: input.sessionId, workspacePath: input.workspacePath }).pipe(
      Effect.mapError((cause) =>
        cause instanceof SessionNotResumable
          ? cause
          : new AgentOpenError({ harnessAgentId: "codex", cause }),
      ),
      Effect.flatMap(({ sessionId }) => makeSession(agent, sessionId)),
    ),
});
