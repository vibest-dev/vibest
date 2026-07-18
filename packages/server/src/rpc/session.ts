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
// SessionService façade. Only `subscribe` reaches the EventBus directly — it is
// the event plane, distinct from the session control plane.
export const sessionRouter = orpc.router({
  // lifecycle -----------------------------------------------------------------
  create: orpc.create.effect(function* ({ input }) {
    const sessions = yield* SessionService;
    return yield* sessions.create(input.projectId, input.harnessAgentId);
  }),
  resume: orpc.resume.effect(function* ({ input }) {
    const sessions = yield* SessionService;
    return yield* sessions.resume(input.ref);
  }),
  close: orpc.close.effect(function* ({ input }) {
    const sessions = yield* SessionService;
    yield* sessions.close(input.ref);
  }),

  // history / index -----------------------------------------------------------
  list: orpc.list.effect(function* ({ input }) {
    const sessions = yield* SessionService;
    return { sessions: yield* sessions.list(input.projectId) };
  }),
  rename: orpc.rename.effect(function* ({ input }) {
    const sessions = yield* SessionService;
    yield* sessions.rename(input.ref, input.name);
  }),
  delete: orpc.delete.effect(function* ({ input }) {
    const sessions = yield* SessionService;
    yield* sessions.delete(input.ref);
  }),
  getMessages: orpc.getMessages.effect(function* () {
    // Native history reads land with a later effort; empty for now.
    return yield* Effect.succeed({ messages: [] });
  }),
  resolveRef: orpc.resolveRef.effect(function* ({ input }) {
    const sessions = yield* SessionService;
    return yield* sessions.resolveRef(input.sessionId);
  }),

  // active instance -----------------------------------------------------------
  prompt: orpc.prompt.effect(function* ({ input }) {
    const sessions = yield* SessionService;
    return yield* sessions.prompt(input);
  }),
  interrupt: orpc.interrupt.effect(function* ({ input }) {
    const sessions = yield* SessionService;
    yield* sessions.interrupt(input.ref);
  }),
  respondToAgentRequest: orpc.respondToAgentRequest.effect(function* ({ input }) {
    const sessions = yield* SessionService;
    yield* sessions.respondToAgentRequest(input.ref, input.requestId, input.response);
  }),
  getStatus: orpc.getStatus.effect(function* ({ input }) {
    const sessions = yield* SessionService;
    return yield* sessions.getStatus(input.ref);
  }),
  getSnapshot: orpc.getSnapshot.effect(function* ({ input }) {
    const sessions = yield* SessionService;
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
