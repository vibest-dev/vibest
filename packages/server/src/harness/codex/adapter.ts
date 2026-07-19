import type { SessionEvent } from "@vibest/harness";
import type { CodexUIMessageChunk, SessionEnvelopeDraft } from "@vibest/harness";
import { Effect, Queue, Ref, Scope, Stream } from "effect";
import type * as Cause from "effect/Cause";

import type {
  HarnessAgentAdapter,
  HarnessAgentSession,
  SessionInfoResult,
  UserInput,
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
  checkAvailability: Effect.succeed({ available: true }),
  open: (input) =>
    agent.session.create({ workspacePath: input.workspacePath }).pipe(
      Effect.mapError((cause) => new AgentOpenError({ harnessAgentId: "codex", cause })),
      Effect.flatMap(({ sessionId }) => makeSession(agent, sessionId)),
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
