import "@orpc/experimental-effect/extensions/effect";
import { implement } from "@orpc/server";
import { sessionContract } from "@vibest/contract/session";
import { Effect } from "effect";

import { EventBus } from "../events";
import { HarnessAgentSessionService } from "../harness";
import { ProjectService } from "../project";
import type { RpcContext } from "./context";
import {
  activeSessionTranslation,
  agentAvailabilityTranslation,
  internalWithMessage,
  projectRefTranslation,
  resumeInternalTranslation,
  sessionRefTranslation,
  translateErrors,
} from "./error-translation";
import { openScopedSubscription } from "./session-stream";
import { streamToAsyncGenerator } from "./stream";

const orpc = implement(sessionContract).$context<RpcContext>();

// Thin transport binding: the router's own work is resolving a projectId to a
// workspace path (the one thing the session service must never do itself) and
// mapping typed effect errors onto the contract's declared codes — clients
// branch on the code, never on the message. Everything else is a one-liner
// onto the HarnessAgentSessionService façade. Every operation's translation
// table is exhaustive over its error channel (`translateErrors`): store I/O
// stays `"internal"` by decision, never by omission. Only `subscribe` reaches
// the EventBus directly — it is the event plane, distinct from the session
// control plane.
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
    return yield* translateErrors(
      projects.findById(input.projectId).pipe(
        Effect.flatMap((project) =>
          sessions.create(input.projectId, input.harnessAgentId, project.path, {
            ...(input.modelId !== undefined ? { model: input.modelId } : {}),
            ...(input.reasoningEffort !== undefined
              ? { reasoningEffort: input.reasoningEffort }
              : {}),
            ...(input.permissionMode !== undefined ? { permissionMode: input.permissionMode } : {}),
          }),
        ),
      ),
      {
        ...projectRefTranslation(errors),
        ...agentAvailabilityTranslation(errors),
        PermissionModeUnsupported: (e) =>
          Effect.fail(errors.INVALID_ARGUMENT({ message: e.message })),
        AgentOpenError: internalWithMessage(errors),
        StoreReadError: "internal",
        StoreWriteError: "internal",
      },
    );
  }),
  // Opening a session page: validate, backfill cwd, confirm the harness still
  // has the native session. No process is started here — that is the whole
  // point of the name.
  prepare: orpc.prepare.effect(function* ({ input, errors }) {
    const projects = yield* ProjectService;
    const sessions = yield* HarnessAgentSessionService;
    return yield* translateErrors(
      projects.findById(input.ref.projectId).pipe(
        Effect.flatMap((project) => sessions.prepare(input.ref, project.path)),
        Effect.as(input.ref),
      ),
      {
        ...projectRefTranslation(errors),
        ...sessionRefTranslation(errors),
        HarnessAgentNotFound: (e) => Effect.fail(errors.UNSUPPORTED({ message: e.message })),
        SessionNotResumable: internalWithMessage(errors),
        AgentOperationError: internalWithMessage(errors),
        StoreWriteError: "internal",
      },
    );
  }),
  close: orpc.close.effect(function* ({ input, errors }) {
    const sessions = yield* HarnessAgentSessionService;
    yield* translateErrors(sessions.close(input.ref), sessionRefTranslation(errors));
  }),

  // history / index -----------------------------------------------------------
  list: orpc.list.effect(function* ({ input, errors }) {
    const projects = yield* ProjectService;
    const sessions = yield* HarnessAgentSessionService;
    return yield* translateErrors(
      projects
        .findById(input.projectId)
        .pipe(Effect.andThen(sessions.list(input.projectId, input.archived ?? false))),
      {
        ...projectRefTranslation(errors),
        StoreReadError: "internal",
      },
    );
  }),
  rename: orpc.rename.effect(function* ({ input, errors }) {
    const sessions = yield* HarnessAgentSessionService;
    yield* translateErrors(sessions.rename(input.ref, input.title), {
      ...sessionRefTranslation(errors),
      StoreWriteError: "internal",
    });
  }),
  archive: orpc.archive.effect(function* ({ input, errors }) {
    const sessions = yield* HarnessAgentSessionService;
    yield* translateErrors(sessions.archive(input.ref, input.archived), {
      ...sessionRefTranslation(errors),
      StoreWriteError: "internal",
    });
  }),
  delete: orpc.delete.effect(function* ({ input, errors }) {
    const sessions = yield* HarnessAgentSessionService;
    yield* translateErrors(sessions.delete(input.ref), {
      ...sessionRefTranslation(errors),
      StoreWriteError: "internal",
    });
  }),
  getMessages: orpc.getMessages.effect(function* ({ input, errors }) {
    const projects = yield* ProjectService;
    const sessions = yield* HarnessAgentSessionService;
    return yield* translateErrors(
      projects.findById(input.ref.projectId).pipe(
        Effect.flatMap((project) => sessions.getMessages(input.ref, project.path)),
        Effect.map((messages) => ({ messages })),
      ),
      {
        ...projectRefTranslation(errors),
        ...sessionRefTranslation(errors),
        ...agentAvailabilityTranslation(errors),
        ...resumeInternalTranslation(errors),
        CapabilityUnsupported: (e) => Effect.fail(errors.UNSUPPORTED({ message: e.message })),
        SessionClosed: (e) =>
          Effect.fail(errors.SESSION_NOT_ACTIVE({ message: `session ${e.sessionId} is closed` })),
        AgentOperationError: internalWithMessage(errors),
      },
    );
  }),
  resolveRef: orpc.resolveRef.effect(function* ({ input, errors }) {
    const sessions = yield* HarnessAgentSessionService;
    return yield* translateErrors(sessions.resolveRef(input.sessionId), {
      SessionRefNotFound: (e) =>
        Effect.fail(errors.NOT_FOUND({ message: `session ${e.sessionId} not found` })),
      StoreReadError: "internal",
    });
  }),

  // active instance -----------------------------------------------------------
  prompt: orpc.prompt.effect(function* ({ input, errors }) {
    const sessions = yield* HarnessAgentSessionService;
    return yield* translateErrors(sessions.prompt(input), {
      ...sessionRefTranslation(errors),
      ...activeSessionTranslation(errors),
      ...agentAvailabilityTranslation(errors),
      SessionNotResumable: internalWithMessage(errors),
      AgentOpenError: internalWithMessage(errors),
      UnsupportedPromptPart: (e) =>
        Effect.fail(errors.UNSUPPORTED({ message: `unsupported prompt part: ${e.kind}` })),
      TurnAlreadyRunning: (e) =>
        Effect.fail(
          errors.CONFLICT({ message: `a turn is already running in session ${e.sessionId}` }),
        ),
    });
  }),
  steer: orpc.steer.effect(function* ({ input, errors }) {
    const sessions = yield* HarnessAgentSessionService;
    yield* sessions.steer(input).pipe(
      Effect.catchTags({
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
        HarnessAgentNotFound: (e) => Effect.fail(errors.UNSUPPORTED({ message: e.message })),
        SessionClosed: (e) =>
          Effect.fail(errors.SESSION_NOT_ACTIVE({ message: `session ${e.sessionId} is closed` })),
        TurnAlreadyRunning: (e) => Effect.fail(errors.CONFLICT({ message: e.message })),
        AgentOperationError: (e) => Effect.fail(errors.INTERNAL({ message: e.message })),
      }),
    );
  }),
  interrupt: orpc.interrupt.effect(function* ({ input, errors }) {
    const sessions = yield* HarnessAgentSessionService;
    yield* translateErrors(sessions.interrupt(input.ref), {
      ...sessionRefTranslation(errors),
      SessionClosed: (e) =>
        Effect.fail(errors.SESSION_NOT_ACTIVE({ message: `session ${e.sessionId} is closed` })),
      AgentOperationError: internalWithMessage(errors),
    });
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
    yield* translateErrors(sessions.setModel(input.ref, input.modelId), {
      ...sessionRefTranslation(errors),
      SessionClosed: (e) =>
        Effect.fail(errors.SESSION_NOT_ACTIVE({ message: `session ${e.sessionId} is closed` })),
      AgentOperationError: internalWithMessage(errors),
    });
  }),
  setReasoningEffort: orpc.setReasoningEffort.effect(function* ({ input, errors }) {
    const sessions = yield* HarnessAgentSessionService;
    yield* translateErrors(sessions.setReasoningEffort(input.ref, input.reasoningEffort), {
      ...sessionRefTranslation(errors),
      SessionClosed: (e) =>
        Effect.fail(errors.SESSION_NOT_ACTIVE({ message: `session ${e.sessionId} is closed` })),
      AgentOperationError: internalWithMessage(errors),
    });
  }),
  setPermissionMode: orpc.setPermissionMode.effect(function* ({ input, errors }) {
    const sessions = yield* HarnessAgentSessionService;
    yield* translateErrors(sessions.setPermissionMode(input.ref, input.permissionMode), {
      ...sessionRefTranslation(errors),
      SessionClosed: (e) =>
        Effect.fail(errors.SESSION_NOT_ACTIVE({ message: `session ${e.sessionId} is closed` })),
      AgentOperationError: internalWithMessage(errors),
      // Our closed vocabulary, but outside this harness's declared subset —
      // a client bug (the subset is fully known client-side), never ignored.
      PermissionModeUnsupported: (e) =>
        Effect.fail(errors.INVALID_ARGUMENT({ message: e.message })),
    });
  }),
  respondToAgentRequest: orpc.respondToAgentRequest.effect(function* ({ input, errors }) {
    const sessions = yield* HarnessAgentSessionService;
    // No SessionClosed here: responding to a request of a session that closed
    // meanwhile surfaces as the request itself being gone.
    yield* translateErrors(
      sessions.respondToAgentRequest(input.ref, input.requestId, input.response),
      {
        ...sessionRefTranslation(errors),
        AgentRequestUnavailable: (e) =>
          Effect.fail(errors.NOT_FOUND({ message: `request ${e.requestId} is not pending` })),
        AgentOperationError: internalWithMessage(errors),
      },
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
