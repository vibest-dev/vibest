import type { SessionEvent } from "@vibest/harness";
import type { CodexUIMessageChunk, SessionEnvelopeDraft } from "@vibest/harness";
import type { AskForApproval, SandboxPolicy } from "@vibest/harness/codex/protocol/v2";
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
  CodexRpcError,
  SessionClosed,
  SessionNotResumable,
  TurnAlreadyRunning,
} from "../errors";
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

// Map codex's outward permission-mode ids onto its approval policy + sandbox.
// Unknown ids yield undefined so setPermissionMode can reject them.
const CODEX_PERMISSIONS: Record<string, CodexPermission> = {
  "read-only": {
    approvalPolicy: "on-request",
    sandboxPolicy: { type: "readOnly", networkAccess: false },
  },
  ask: { approvalPolicy: "on-request", sandboxPolicy: workspaceWrite },
  full: { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } },
};
const toCodexPermission = (id: string): CodexPermission | undefined => CODEX_PERMISSIONS[id];

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
