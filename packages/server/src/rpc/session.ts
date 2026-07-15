import "@orpc/experimental-effect/extensions/effect";
import { implement } from "@orpc/server";
import { sessionContract } from "@vibest/contract/session";
import { HarnessAgentSessionService } from "@vibest/harness/runtime";
import { Stream } from "effect";

import { EventBus } from "../events";
import type { RpcContext } from "./context";
import { openRawEventSubscription } from "./session-stream";
import { streamToAsyncGenerator } from "./stream";

const orpc = implement(sessionContract).$context<RpcContext>();

export const sessionRouter = orpc.router({
  create: orpc.create.effect(function* ({ input }) {
    const sessions = yield* HarnessAgentSessionService;
    return yield* sessions.create(input.harnessAgentId, {
      workspacePath: input.workspacePath ?? process.cwd(),
    });
  }),
  resume: orpc.resume.effect(function* ({ input }) {
    const sessions = yield* HarnessAgentSessionService;
    yield* sessions.resume(input);
  }),
  prompt: orpc.prompt.effect(function* ({ input }) {
    const sessions = yield* HarnessAgentSessionService;
    return yield* sessions.prompt(input.sessionId, input.input);
  }),
  interrupt: orpc.interrupt.effect(function* ({ input }) {
    const sessions = yield* HarnessAgentSessionService;
    yield* sessions.interrupt(input.sessionId);
  }),
  close: orpc.close.effect(function* ({ input }) {
    const sessions = yield* HarnessAgentSessionService;
    yield* sessions.close(input.sessionId);
  }),
  events: orpc.events.effect(function* ({ input }) {
    const bus = yield* EventBus;
    const subscription = yield* openRawEventSubscription(bus, { sessionId: input.sessionId });
    const after = input.after ?? 0;
    const events = subscription.events.pipe(
      Stream.filter((item) =>
        item.type === "event" ? item.event.seq > after : item.cursor > after,
      ),
    );
    return streamToAsyncGenerator(events);
  }),
  snapshot: orpc.snapshot.effect(function* ({ input }) {
    const sessions = yield* HarnessAgentSessionService;
    return yield* sessions.getSnapshot(input.sessionId);
  }),
  status: orpc.status.effect(function* ({ input }) {
    const sessions = yield* HarnessAgentSessionService;
    return yield* sessions.getStatus(input.sessionId);
  }),
  capabilities: orpc.capabilities.effect(function* ({ input }) {
    const sessions = yield* HarnessAgentSessionService;
    return yield* sessions.getCapabilities(input.sessionId);
  }),
  respondToAgentRequest: orpc.respondToAgentRequest.effect(function* ({ input }) {
    const sessions = yield* HarnessAgentSessionService;
    yield* sessions.respondToAgentRequest(input.sessionId, input.requestId, input.response);
  }),
});

export type SessionRouter = typeof sessionRouter;
