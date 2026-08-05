import "@orpc/experimental-effect/extensions/effect";
import { implement } from "@orpc/server";
import { sessionContract } from "@vibest/contract/session";
import { Effect } from "effect";

import { EventBus } from "../events";
import { HarnessAgentSessionService } from "../harness";
import { ProjectService } from "../project";
import type { RpcContext } from "./context";
import { openScopedSubscription } from "./session-stream";
import { streamToAsyncGenerator } from "./stream";

const orpc = implement(sessionContract).$context<RpcContext>();

// Thin transport binding: the router's own work is resolving a projectId to a
// workspace path (the one thing the session service must never do itself) and
// mapping typed effect errors onto the contract's declared codes — clients
// branch on the code, never on the message. Everything else is a one-liner
// onto the HarnessAgentSessionService façade. Unmapped errors (store I/O)
// intentionally surface as INTERNAL. Only `subscribe` reaches the EventBus
// directly — it is the event plane, distinct from the session control plane.
export const sessionRouter = orpc.router({
  // lifecycle -----------------------------------------------------------------
  create: orpc.create.effect(function* ({ input, errors }) {
    const projects = yield* ProjectService;
    const sessions = yield* HarnessAgentSessionService;
    // The providerId/modelId pair is validated and unpacked here: the two are
    // only meaningful together (a half pair is a client bug), and today a
    // harness can only consume its own built-in provider, so anything else is
    // a request this server cannot honour. Past this point the model travels
    // as a provider-local id.
    if ((input.providerId === undefined) !== (input.modelId === undefined)) {
      return yield* Effect.fail(
        errors.INVALID_ARGUMENT({
          message: "providerId and modelId must be given together",
        }),
      );
    }
    if (input.providerId !== undefined && input.providerId !== input.harnessAgentId) {
      return yield* Effect.fail(
        errors.UNSUPPORTED({
          message: `provider ${input.providerId} is not consumable by ${input.harnessAgentId}`,
        }),
      );
    }
    return yield* projects.findById(input.projectId).pipe(
      Effect.flatMap((project) =>
        sessions.create(input.projectId, input.harnessAgentId, project.path, {
          ...(input.modelId !== undefined ? { model: input.modelId } : {}),
          ...(input.reasoningEffort !== undefined
            ? { reasoningEffort: input.reasoningEffort }
            : {}),
          ...(input.permissionMode !== undefined ? { permissionMode: input.permissionMode } : {}),
        }),
      ),
      Effect.catchTags({
        ProjectNotFound: (e) =>
          Effect.fail(errors.NOT_FOUND({ message: `project ${e.projectId} not found` })),
        HarnessAgentNotFound: (e) => Effect.fail(errors.UNSUPPORTED({ message: e.message })),
        AgentUnavailable: (e) =>
          Effect.fail(errors.UNSUPPORTED({ message: `${e.harnessAgentId}: ${e.reason}` })),
        ExecutableNotFound: (e) => Effect.fail(errors.UNSUPPORTED({ message: e.message })),
        PermissionModeUnsupported: (e) =>
          Effect.fail(errors.INVALID_ARGUMENT({ message: e.message })),
        AgentOpenError: (e) => Effect.fail(errors.INTERNAL({ message: e.message })),
      }),
    );
  }),
  // Opening a session page: validate, backfill cwd, confirm the harness still
  // has the native session. No process is started here — that is the whole
  // point of the name.
  prepare: orpc.prepare.effect(function* ({ input, errors }) {
    const projects = yield* ProjectService;
    const sessions = yield* HarnessAgentSessionService;
    return yield* projects.findById(input.ref.projectId).pipe(
      Effect.flatMap((project) => sessions.prepare(input.ref, project.path)),
      Effect.as(input.ref),
      Effect.catchTags({
        SessionNotFound: (e) =>
          Effect.fail(errors.NOT_FOUND({ message: `session ${e.sessionId} not found` })),
        SessionRefMismatch: (e) =>
          Effect.fail(
            errors.INVALID_ARGUMENT({ message: `ref mismatch for session ${e.sessionId}` }),
          ),
        ProjectNotFound: (e) =>
          Effect.fail(errors.NOT_FOUND({ message: `project ${e.projectId} not found` })),
        HarnessAgentNotFound: (e) => Effect.fail(errors.UNSUPPORTED({ message: e.message })),
        SessionNotResumable: (e) => Effect.fail(errors.INTERNAL({ message: e.message })),
        AgentOperationError: (e) => Effect.fail(errors.INTERNAL({ message: e.message })),
      }),
    );
  }),
  close: orpc.close.effect(function* ({ input, errors }) {
    const sessions = yield* HarnessAgentSessionService;
    yield* sessions.close(input.ref).pipe(
      Effect.catchTags({
        SessionNotFound: (e) =>
          Effect.fail(errors.NOT_FOUND({ message: `session ${e.sessionId} not found` })),
        SessionRefMismatch: (e) =>
          Effect.fail(
            errors.INVALID_ARGUMENT({ message: `ref mismatch for session ${e.sessionId}` }),
          ),
      }),
    );
  }),

  // history / index -----------------------------------------------------------
  list: orpc.list.effect(function* ({ input, errors }) {
    const projects = yield* ProjectService;
    const sessions = yield* HarnessAgentSessionService;
    return yield* projects.findById(input.projectId).pipe(
      Effect.andThen(sessions.list(input.projectId)),
      Effect.catchTags({
        ProjectNotFound: (e) =>
          Effect.fail(errors.NOT_FOUND({ message: `project ${e.projectId} not found` })),
      }),
    );
  }),
  rename: orpc.rename.effect(function* ({ input, errors }) {
    const sessions = yield* HarnessAgentSessionService;
    yield* sessions.rename(input.ref, input.name).pipe(
      Effect.catchTags({
        SessionNotFound: (e) =>
          Effect.fail(errors.NOT_FOUND({ message: `session ${e.sessionId} not found` })),
        SessionRefMismatch: (e) =>
          Effect.fail(
            errors.INVALID_ARGUMENT({ message: `ref mismatch for session ${e.sessionId}` }),
          ),
      }),
    );
  }),
  delete: orpc.delete.effect(function* ({ input, errors }) {
    const sessions = yield* HarnessAgentSessionService;
    yield* sessions.delete(input.ref).pipe(
      Effect.catchTags({
        SessionNotFound: (e) =>
          Effect.fail(errors.NOT_FOUND({ message: `session ${e.sessionId} not found` })),
        SessionRefMismatch: (e) =>
          Effect.fail(
            errors.INVALID_ARGUMENT({ message: `ref mismatch for session ${e.sessionId}` }),
          ),
      }),
    );
  }),
  getMessages: orpc.getMessages.effect(function* ({ input, errors }) {
    const projects = yield* ProjectService;
    const sessions = yield* HarnessAgentSessionService;
    return yield* projects.findById(input.ref.projectId).pipe(
      Effect.flatMap((project) => sessions.getMessages(input.ref, project.path)),
      Effect.map((messages) => ({ messages })),
      Effect.catchTags({
        ProjectNotFound: (e) =>
          Effect.fail(errors.NOT_FOUND({ message: `project ${e.projectId} not found` })),
        SessionNotFound: (e) =>
          Effect.fail(errors.NOT_FOUND({ message: `session ${e.sessionId} not found` })),
        SessionRefMismatch: (e) =>
          Effect.fail(
            errors.INVALID_ARGUMENT({ message: `ref mismatch for session ${e.sessionId}` }),
          ),
        HarnessAgentNotFound: (e) => Effect.fail(errors.UNSUPPORTED({ message: e.message })),
        AgentUnavailable: (e) =>
          Effect.fail(errors.UNSUPPORTED({ message: `${e.harnessAgentId}: ${e.reason}` })),
        ExecutableNotFound: (e) => Effect.fail(errors.UNSUPPORTED({ message: e.message })),
        CapabilityUnsupported: (e) => Effect.fail(errors.UNSUPPORTED({ message: e.message })),
        HarnessSessionNotFound: (e) => Effect.fail(errors.INTERNAL({ message: e.message })),
        SessionNotResumable: (e) => Effect.fail(errors.INTERNAL({ message: e.message })),
        AgentOpenError: (e) => Effect.fail(errors.INTERNAL({ message: e.message })),
        SessionClosed: (e) =>
          Effect.fail(errors.SESSION_NOT_ACTIVE({ message: `session ${e.sessionId} is closed` })),
        AgentOperationError: (e) => Effect.fail(errors.INTERNAL({ message: e.message })),
      }),
    );
  }),
  resolveRef: orpc.resolveRef.effect(function* ({ input, errors }) {
    const sessions = yield* HarnessAgentSessionService;
    return yield* sessions.resolveRef(input.sessionId).pipe(
      Effect.catchTags({
        SessionRefNotFound: (e) =>
          Effect.fail(errors.NOT_FOUND({ message: `session ${e.sessionId} not found` })),
      }),
    );
  }),

  // active instance -----------------------------------------------------------
  prompt: orpc.prompt.effect(function* ({ input, errors }) {
    const sessions = yield* HarnessAgentSessionService;
    return yield* sessions.prompt(input).pipe(
      Effect.catchTags({
        // The repository's SessionNotFound means the metadata is gone →
        // NOT_FOUND; the harness's HarnessSessionNotFound means the native
        // session is not open → SESSION_NOT_ACTIVE.
        SessionNotFound: (e) =>
          Effect.fail(errors.NOT_FOUND({ message: `session ${e.sessionId} not found` })),
        HarnessSessionNotFound: (e) =>
          Effect.fail(
            errors.SESSION_NOT_ACTIVE({ message: `session ${e.sessionId} is not active` }),
          ),
        SessionRefMismatch: (e) =>
          Effect.fail(
            errors.INVALID_ARGUMENT({ message: `ref mismatch for session ${e.sessionId}` }),
          ),
        UnsupportedPromptPart: (e) =>
          Effect.fail(errors.UNSUPPORTED({ message: `unsupported prompt part: ${e.kind}` })),
        // A prompt is what starts an agent, so it is also where starting one
        // can fail. Same mapping the create path uses.
        HarnessAgentNotFound: (e) => Effect.fail(errors.UNSUPPORTED({ message: e.message })),
        AgentUnavailable: (e) =>
          Effect.fail(errors.UNSUPPORTED({ message: `${e.harnessAgentId}: ${e.reason}` })),
        ExecutableNotFound: (e) => Effect.fail(errors.UNSUPPORTED({ message: e.message })),
        SessionNotResumable: (e) => Effect.fail(errors.INTERNAL({ message: e.message })),
        AgentOpenError: (e) => Effect.fail(errors.INTERNAL({ message: e.message })),
        SessionClosed: (e) =>
          Effect.fail(errors.SESSION_NOT_ACTIVE({ message: `session ${e.sessionId} is closed` })),
        TurnAlreadyRunning: (e) =>
          Effect.fail(
            errors.CONFLICT({ message: `a turn is already running in session ${e.sessionId}` }),
          ),
        AgentOperationError: (e) => Effect.fail(errors.INTERNAL({ message: e.message })),
      }),
    );
  }),
  interrupt: orpc.interrupt.effect(function* ({ input, errors }) {
    const sessions = yield* HarnessAgentSessionService;
    yield* sessions.interrupt(input.ref).pipe(
      Effect.catchTags({
        SessionNotFound: (e) =>
          Effect.fail(errors.NOT_FOUND({ message: `session ${e.sessionId} not found` })),
        SessionRefMismatch: (e) =>
          Effect.fail(
            errors.INVALID_ARGUMENT({ message: `ref mismatch for session ${e.sessionId}` }),
          ),
        SessionClosed: (e) =>
          Effect.fail(errors.SESSION_NOT_ACTIVE({ message: `session ${e.sessionId} is closed` })),
        AgentOperationError: (e) => Effect.fail(errors.INTERNAL({ message: e.message })),
      }),
    );
  }),
  setModel: orpc.setModel.effect(function* ({ input, errors }) {
    const sessions = yield* HarnessAgentSessionService;
    // Same providerId gate as `create`: a harness only consumes its own
    // built-in provider today.
    if (input.providerId !== input.ref.harnessAgentId) {
      return yield* Effect.fail(
        errors.UNSUPPORTED({
          message: `provider ${input.providerId} is not consumable by ${input.ref.harnessAgentId}`,
        }),
      );
    }
    yield* sessions.setModel(input.ref, input.modelId).pipe(
      Effect.catchTags({
        SessionNotFound: (e) =>
          Effect.fail(errors.NOT_FOUND({ message: `session ${e.sessionId} not found` })),
        SessionRefMismatch: (e) =>
          Effect.fail(
            errors.INVALID_ARGUMENT({ message: `ref mismatch for session ${e.sessionId}` }),
          ),
        SessionClosed: (e) =>
          Effect.fail(errors.SESSION_NOT_ACTIVE({ message: `session ${e.sessionId} is closed` })),
        AgentOperationError: (e) => Effect.fail(errors.INTERNAL({ message: e.message })),
      }),
    );
  }),
  setReasoningEffort: orpc.setReasoningEffort.effect(function* ({ input, errors }) {
    const sessions = yield* HarnessAgentSessionService;
    yield* sessions.setReasoningEffort(input.ref, input.reasoningEffort).pipe(
      Effect.catchTags({
        SessionNotFound: (e) =>
          Effect.fail(errors.NOT_FOUND({ message: `session ${e.sessionId} not found` })),
        SessionRefMismatch: (e) =>
          Effect.fail(
            errors.INVALID_ARGUMENT({ message: `ref mismatch for session ${e.sessionId}` }),
          ),
        SessionClosed: (e) =>
          Effect.fail(errors.SESSION_NOT_ACTIVE({ message: `session ${e.sessionId} is closed` })),
        AgentOperationError: (e) => Effect.fail(errors.INTERNAL({ message: e.message })),
      }),
    );
  }),
  setPermissionMode: orpc.setPermissionMode.effect(function* ({ input, errors }) {
    const sessions = yield* HarnessAgentSessionService;
    yield* sessions.setPermissionMode(input.ref, input.permissionMode).pipe(
      Effect.catchTags({
        SessionNotFound: (e) =>
          Effect.fail(errors.NOT_FOUND({ message: `session ${e.sessionId} not found` })),
        SessionRefMismatch: (e) =>
          Effect.fail(
            errors.INVALID_ARGUMENT({ message: `ref mismatch for session ${e.sessionId}` }),
          ),
        // Our closed vocabulary, but outside this harness's declared subset —
        // a client bug (the subset is fully known client-side), never ignored.
        PermissionModeUnsupported: (e) =>
          Effect.fail(errors.INVALID_ARGUMENT({ message: e.message })),
        SessionClosed: (e) =>
          Effect.fail(errors.SESSION_NOT_ACTIVE({ message: `session ${e.sessionId} is closed` })),
        AgentOperationError: (e) => Effect.fail(errors.INTERNAL({ message: e.message })),
      }),
    );
  }),
  respondToAgentRequest: orpc.respondToAgentRequest.effect(function* ({ input, errors }) {
    const sessions = yield* HarnessAgentSessionService;
    yield* sessions.respondToAgentRequest(input.ref, input.requestId, input.response).pipe(
      Effect.catchTags({
        SessionNotFound: (e) =>
          Effect.fail(errors.NOT_FOUND({ message: `session ${e.sessionId} not found` })),
        SessionRefMismatch: (e) =>
          Effect.fail(
            errors.INVALID_ARGUMENT({ message: `ref mismatch for session ${e.sessionId}` }),
          ),
        AgentRequestUnavailable: (e) =>
          Effect.fail(errors.NOT_FOUND({ message: `request ${e.requestId} is not pending` })),
        AgentOperationError: (e) => Effect.fail(errors.INTERNAL({ message: e.message })),
      }),
    );
  }),
  // Total, and deliberately so: a persisted session this process has not
  // touched reads as idle rather than SESSION_NOT_ACTIVE. A client reattaching
  // after a server restart used to get that error on every snapshot and retry
  // forever, because nothing on the observation path could ever make it go
  // away.
  getStatus: orpc.getStatus.effect(function* ({ input }) {
    const sessions = yield* HarnessAgentSessionService;
    return yield* sessions.getStatus(input.ref);
  }),
  getSnapshot: orpc.getSnapshot.effect(function* ({ input }) {
    const sessions = yield* HarnessAgentSessionService;
    return yield* sessions.getSnapshot(input.ref);
  }),

  // events --------------------------------------------------------------------
  subscribe: orpc.subscribe.effect(function* ({ input }) {
    const bus = yield* EventBus;
    const stream = yield* openScopedSubscription(bus, input.scope);
    return streamToAsyncGenerator(stream);
  }),
});

export type SessionRouter = typeof sessionRouter;
