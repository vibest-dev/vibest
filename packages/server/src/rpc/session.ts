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
  resume: orpc.resume.effect(function* ({ input, errors }) {
    const projects = yield* ProjectService;
    const sessions = yield* HarnessAgentSessionService;
    return yield* translateErrors(
      projects.findById(input.ref.projectId).pipe(
        Effect.flatMap((project) => sessions.resume(input.ref, project.path)),
        Effect.as(input.ref),
      ),
      {
        ...projectRefTranslation(errors),
        ...sessionRefTranslation(errors),
        ...agentAvailabilityTranslation(errors),
        ...resumeInternalTranslation(errors),
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
      projects.findById(input.projectId).pipe(Effect.andThen(sessions.list(input.projectId))),
      {
        ...projectRefTranslation(errors),
        StoreReadError: "internal",
      },
    );
  }),
  rename: orpc.rename.effect(function* ({ input, errors }) {
    const sessions = yield* HarnessAgentSessionService;
    yield* translateErrors(sessions.rename(input.ref, input.name), sessionRefTranslation(errors));
  }),
  delete: orpc.delete.effect(function* ({ input, errors }) {
    const sessions = yield* HarnessAgentSessionService;
    yield* translateErrors(sessions.delete(input.ref), {
      ...sessionRefTranslation(errors),
      StoreWriteError: "internal",
    });
  }),
  getMessages: orpc.getMessages.effect(function* ({ input, errors }) {
    // Scope gate: only pi serves native history today (tickets 10/11 widen
    // this). The gate also keeps claude-code/codex from paying an ensure — a
    // live process — for a call that would end CapabilityUnsupported anyway.
    if (input.ref.harnessAgentId !== "pi") {
      return yield* Effect.fail(
        errors.UNSUPPORTED({
          message: `native history reads not implemented for ${input.ref.harnessAgentId} yet`,
        }),
      );
    }
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
      UnsupportedPromptPart: (e) =>
        Effect.fail(errors.UNSUPPORTED({ message: `unsupported prompt part: ${e.kind}` })),
      TurnAlreadyRunning: (e) =>
        Effect.fail(
          errors.CONFLICT({ message: `a turn is already running in session ${e.sessionId}` }),
        ),
    });
  }),
  interrupt: orpc.interrupt.effect(function* ({ input, errors }) {
    const sessions = yield* HarnessAgentSessionService;
    yield* translateErrors(sessions.interrupt(input.ref), {
      ...sessionRefTranslation(errors),
      ...activeSessionTranslation(errors),
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
      ...activeSessionTranslation(errors),
    });
  }),
  setReasoningEffort: orpc.setReasoningEffort.effect(function* ({ input, errors }) {
    const sessions = yield* HarnessAgentSessionService;
    yield* translateErrors(sessions.setReasoningEffort(input.ref, input.reasoningEffort), {
      ...sessionRefTranslation(errors),
      ...activeSessionTranslation(errors),
    });
  }),
  setPermissionMode: orpc.setPermissionMode.effect(function* ({ input, errors }) {
    const sessions = yield* HarnessAgentSessionService;
    yield* translateErrors(sessions.setPermissionMode(input.ref, input.permissionMode), {
      ...sessionRefTranslation(errors),
      ...activeSessionTranslation(errors),
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
        HarnessSessionNotFound: (e) =>
          Effect.fail(
            errors.SESSION_NOT_ACTIVE({ message: `session ${e.sessionId} is not active` }),
          ),
        AgentRequestUnavailable: (e) =>
          Effect.fail(errors.NOT_FOUND({ message: `request ${e.requestId} is not pending` })),
        AgentOperationError: internalWithMessage(errors),
      },
    );
  }),
  getStatus: orpc.getStatus.effect(function* ({ input, errors }) {
    const sessions = yield* HarnessAgentSessionService;
    return yield* translateErrors(sessions.getStatus(input.ref), {
      SessionNotActive: (e) =>
        Effect.fail(errors.SESSION_NOT_ACTIVE({ message: `session ${e.sessionId} is not active` })),
    });
  }),
  getSnapshot: orpc.getSnapshot.effect(function* ({ input, errors }) {
    const sessions = yield* HarnessAgentSessionService;
    return yield* translateErrors(sessions.getSnapshot(input.ref), {
      SessionNotActive: (e) =>
        Effect.fail(errors.SESSION_NOT_ACTIVE({ message: `session ${e.sessionId} is not active` })),
    });
  }),

  // events --------------------------------------------------------------------
  subscribe: orpc.subscribe.effect(function* ({ input }) {
    const bus = yield* EventBus;
    const stream = yield* openScopedSubscription(bus, input.scope);
    return streamToAsyncGenerator(stream);
  }),
});

export type SessionRouter = typeof sessionRouter;
