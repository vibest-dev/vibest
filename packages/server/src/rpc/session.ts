import "@orpc/experimental-effect/extensions/effect";
import { implement } from "@orpc/server";
import type { PromptInput } from "@vibest/contract";
import { sessionContract } from "@vibest/contract/session";
import { HarnessAgentSessionService, type UserInput } from "@vibest/harness/runtime";
import { Effect, Stream } from "effect";

import { UnsupportedPromptPart } from "../errors";
import { EventBus } from "../events";
import { SessionRuntimeRegistry, SessionService } from "../session";
import type { RpcContext } from "./context";
import { openScopedSubscription } from "./session-stream";
import { streamToAsyncGenerator } from "./stream";

const orpc = implement(sessionContract).$context<RpcContext>();

/** Wire prompt parts → harness UserInput; `file` parts are rejected, never dropped. */
const toUserInput = (
  parts: PromptInput["parts"],
  model: string | undefined,
): Effect.Effect<UserInput, UnsupportedPromptPart> =>
  Effect.forEach(parts, (part) =>
    part.type === "file"
      ? Effect.fail(new UnsupportedPromptPart({ kind: "file" }))
      : Effect.succeed(part),
  ).pipe(
    Effect.map((userParts) => ({
      parts: userParts,
      ...(model !== undefined ? { model } : {}),
    })),
  );

export const sessionRouter = orpc.router({
  // lifecycle -----------------------------------------------------------------
  create: orpc.create.effect(function* ({ input }) {
    const sessions = yield* SessionService;
    const harness = yield* HarnessAgentSessionService;
    const registry = yield* SessionRuntimeRegistry;
    const bus = yield* EventBus;
    const ref = yield* sessions.create(input.projectId, input.harnessAgentId);
    const nativeId = yield* sessions.resolveHarnessSessionId(ref);
    const events = yield* harness.events(nativeId);
    yield* registry.start(ref, events.pipe(Stream.map((draft) => draft.body)));
    yield* bus.publish({ ref, type: "session.created" });
    return ref;
  }),
  resume: orpc.resume.effect(function* ({ input }) {
    const sessions = yield* SessionService;
    const harness = yield* HarnessAgentSessionService;
    const registry = yield* SessionRuntimeRegistry;
    const ref = yield* sessions.resume(input.ref);
    const nativeId = yield* sessions.resolveHarnessSessionId(ref);
    const events = yield* harness.events(nativeId);
    yield* registry.start(ref, events.pipe(Stream.map((draft) => draft.body)));
    return ref;
  }),
  close: orpc.close.effect(function* ({ input }) {
    const sessions = yield* SessionService;
    const registry = yield* SessionRuntimeRegistry;
    const bus = yield* EventBus;
    yield* registry.stop(input.ref);
    yield* bus.closeSession(input.ref, "session_closed");
    yield* sessions.close(input.ref);
  }),

  // history / index -----------------------------------------------------------
  list: orpc.list.effect(function* ({ input }) {
    const sessions = yield* SessionService;
    return { sessions: yield* sessions.list(input.projectId) };
  }),
  rename: orpc.rename.effect(function* ({ input }) {
    const sessions = yield* SessionService;
    const bus = yield* EventBus;
    // Validate the ref resolves (exists + agent matches) before broadcasting.
    yield* sessions.resolveHarnessSessionId(input.ref);
    yield* bus.publish({ ref: input.ref, type: "session.renamed", name: input.name });
  }),
  delete: orpc.delete.effect(function* ({ input }) {
    const sessions = yield* SessionService;
    const registry = yield* SessionRuntimeRegistry;
    const bus = yield* EventBus;
    yield* registry.stop(input.ref);
    yield* bus.closeSession(input.ref, "session_deleted");
    yield* sessions.delete(input.ref);
    yield* bus.publish({ ref: input.ref, type: "session.deleted" });
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
    const harness = yield* HarnessAgentSessionService;
    const nativeId = yield* sessions.resolveHarnessSessionId(input.ref);
    const userInput = yield* toUserInput(input.parts, input.model);
    return yield* harness.prompt(nativeId, userInput);
  }),
  interrupt: orpc.interrupt.effect(function* ({ input }) {
    const sessions = yield* SessionService;
    const harness = yield* HarnessAgentSessionService;
    const nativeId = yield* sessions.resolveHarnessSessionId(input.ref);
    yield* harness.interrupt(nativeId);
  }),
  respondToAgentRequest: orpc.respondToAgentRequest.effect(function* ({ input }) {
    const sessions = yield* SessionService;
    const harness = yield* HarnessAgentSessionService;
    const nativeId = yield* sessions.resolveHarnessSessionId(input.ref);
    yield* harness.respondToAgentRequest(nativeId, input.requestId, input.response);
  }),
  getStatus: orpc.getStatus.effect(function* ({ input }) {
    const registry = yield* SessionRuntimeRegistry;
    return yield* registry.status(input.ref);
  }),
  getSnapshot: orpc.getSnapshot.effect(function* ({ input }) {
    const registry = yield* SessionRuntimeRegistry;
    return yield* registry.snapshot(input.ref);
  }),

  // events --------------------------------------------------------------------
  subscribe: orpc.subscribe.effect(function* ({ input }) {
    const bus = yield* EventBus;
    const stream = yield* openScopedSubscription(bus, input.scope);
    return streamToAsyncGenerator(stream);
  }),
});

export type SessionRouter = typeof sessionRouter;
