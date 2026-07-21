import "@orpc/experimental-effect/extensions/effect";
import { implement } from "@orpc/server";
import { sessionContract } from "@vibest/contract/session";
import { Effect } from "effect";

import { EventBus } from "../events";
import { SessionService } from "../session";
import type { RpcContext } from "./context";
import { openScopedSubscription } from "./session-stream";
import { streamToAsyncGenerator } from "./stream";

const orpc = implement(sessionContract).$context<RpcContext>();

// Thin transport binding: every session operation is a one-liner onto the
// SessionService façade, plus a catchTags block mapping its typed effect errors
// onto the contract's declared codes — clients branch on the code, never on the
// message. Unmapped errors (store I/O) intentionally surface as INTERNAL. Only
// `subscribe` reaches the EventBus directly — it is the event plane, distinct
// from the session control plane.
export const sessionRouter = orpc.router({
  // lifecycle -----------------------------------------------------------------
  create: orpc.create.effect(function* ({ input, errors }) {
    const sessions = yield* SessionService;
    return yield* sessions
      .create(input.projectId, input.harnessAgentId, {
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.permissionMode !== undefined ? { permissionMode: input.permissionMode } : {}),
      })
      .pipe(
        Effect.catchTags({
          ProjectNotFound: (e) =>
            Effect.fail(errors.NOT_FOUND({ message: `project ${e.projectId} not found` })),
          AgentUnavailable: (e) =>
            Effect.fail(errors.UNSUPPORTED({ message: `${e.harnessAgentId}: ${e.reason}` })),
          SessionOpenFailed: (e) => Effect.fail(errors.INTERNAL({ message: e.reason })),
        }),
      );
  }),
  resume: orpc.resume.effect(function* ({ input, errors }) {
    const sessions = yield* SessionService;
    return yield* sessions.resume(input.ref).pipe(
      Effect.catchTags({
        SessionNotFound: (e) =>
          Effect.fail(errors.NOT_FOUND({ message: `session ${e.sessionId} not found` })),
        SessionRefMismatch: (e) =>
          Effect.fail(
            errors.INVALID_ARGUMENT({ message: `ref mismatch for session ${e.sessionId}` }),
          ),
        ProjectNotFound: (e) =>
          Effect.fail(errors.NOT_FOUND({ message: `project ${e.projectId} not found` })),
        AgentUnavailable: (e) =>
          Effect.fail(errors.UNSUPPORTED({ message: `${e.harnessAgentId}: ${e.reason}` })),
        SessionResumeFailed: (e) => Effect.fail(errors.INTERNAL({ message: e.reason })),
      }),
    );
  }),
  close: orpc.close.effect(function* ({ input, errors }) {
    const sessions = yield* SessionService;
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
    const sessions = yield* SessionService;
    return yield* sessions.list(input.projectId).pipe(
      Effect.catchTags({
        ProjectNotFound: (e) =>
          Effect.fail(errors.NOT_FOUND({ message: `project ${e.projectId} not found` })),
      }),
    );
  }),
  rename: orpc.rename.effect(function* ({ input, errors }) {
    const sessions = yield* SessionService;
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
    const sessions = yield* SessionService;
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
  getMessages: orpc.getMessages.effect(function* ({ errors }) {
    // Native history reads land with tickets 10/11. Failing UNSUPPORTED (per
    // the contract's convention — never silently degrade) keeps an empty
    // transcript distinguishable from an unimplemented endpoint.
    return yield* Effect.fail(
      errors.UNSUPPORTED({ message: "native history reads not implemented yet" }),
    );
  }),
  resolveRef: orpc.resolveRef.effect(function* ({ input, errors }) {
    const sessions = yield* SessionService;
    return yield* sessions.resolveRef(input.sessionId).pipe(
      Effect.catchTags({
        SessionRefNotFound: (e) =>
          Effect.fail(errors.NOT_FOUND({ message: `session ${e.sessionId} not found` })),
      }),
    );
  }),

  // active instance -----------------------------------------------------------
  prompt: orpc.prompt.effect(function* ({ input, errors }) {
    const sessions = yield* SessionService;
    return yield* sessions.prompt(input).pipe(
      Effect.catchTags({
        // The repository's SessionNotFound (has projectId) means the metadata is
        // gone → NOT_FOUND; the harness's (bare sessionId) means the native
        // session is not open → SESSION_NOT_ACTIVE.
        SessionNotFound: (e) =>
          Effect.fail(
            "projectId" in e
              ? errors.NOT_FOUND({ message: `session ${e.sessionId} not found` })
              : errors.SESSION_NOT_ACTIVE({ message: `session ${e.sessionId} is not active` }),
          ),
        SessionRefMismatch: (e) =>
          Effect.fail(
            errors.INVALID_ARGUMENT({ message: `ref mismatch for session ${e.sessionId}` }),
          ),
        UnsupportedPromptPart: (e) =>
          Effect.fail(errors.UNSUPPORTED({ message: `unsupported prompt part: ${e.kind}` })),
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
    const sessions = yield* SessionService;
    yield* sessions.interrupt(input.ref).pipe(
      Effect.catchTags({
        SessionNotFound: (e) =>
          Effect.fail(
            "projectId" in e
              ? errors.NOT_FOUND({ message: `session ${e.sessionId} not found` })
              : errors.SESSION_NOT_ACTIVE({ message: `session ${e.sessionId} is not active` }),
          ),
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
    const sessions = yield* SessionService;
    yield* sessions.setModel(input.ref, input.model).pipe(
      Effect.catchTags({
        SessionNotFound: (e) =>
          Effect.fail(
            "projectId" in e
              ? errors.NOT_FOUND({ message: `session ${e.sessionId} not found` })
              : errors.SESSION_NOT_ACTIVE({ message: `session ${e.sessionId} is not active` }),
          ),
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
    const sessions = yield* SessionService;
    yield* sessions.setPermissionMode(input.ref, input.permissionMode).pipe(
      Effect.catchTags({
        SessionNotFound: (e) =>
          Effect.fail(
            "projectId" in e
              ? errors.NOT_FOUND({ message: `session ${e.sessionId} not found` })
              : errors.SESSION_NOT_ACTIVE({ message: `session ${e.sessionId} is not active` }),
          ),
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
  respondToAgentRequest: orpc.respondToAgentRequest.effect(function* ({ input, errors }) {
    const sessions = yield* SessionService;
    yield* sessions.respondToAgentRequest(input.ref, input.requestId, input.response).pipe(
      Effect.catchTags({
        SessionNotFound: (e) =>
          Effect.fail(
            "projectId" in e
              ? errors.NOT_FOUND({ message: `session ${e.sessionId} not found` })
              : errors.SESSION_NOT_ACTIVE({ message: `session ${e.sessionId} is not active` }),
          ),
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
  getStatus: orpc.getStatus.effect(function* ({ input, errors }) {
    const sessions = yield* SessionService;
    return yield* sessions.getStatus(input.ref).pipe(
      Effect.catchTags({
        SessionNotActive: (e) =>
          Effect.fail(
            errors.SESSION_NOT_ACTIVE({ message: `session ${e.sessionId} is not active` }),
          ),
      }),
    );
  }),
  getSnapshot: orpc.getSnapshot.effect(function* ({ input, errors }) {
    const sessions = yield* SessionService;
    return yield* sessions.getSnapshot(input.ref).pipe(
      Effect.catchTags({
        SessionNotActive: (e) =>
          Effect.fail(
            errors.SESSION_NOT_ACTIVE({ message: `session ${e.sessionId} is not active` }),
          ),
      }),
    );
  }),

  // events --------------------------------------------------------------------
  subscribe: orpc.subscribe.effect(function* ({ input }) {
    const bus = yield* EventBus;
    const stream = yield* openScopedSubscription(bus, input.scope);
    return streamToAsyncGenerator(stream);
  }),
});

export type SessionRouter = typeof sessionRouter;
