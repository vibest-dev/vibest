import "@orpc/experimental-effect/extensions/effect";
import { implement } from "@orpc/server";
import { sessionContract } from "@vibest/contract/session";
import { Effect, Stream } from "effect";

import { EventBus } from "../events";
import { HarnessAgentSessionService } from "../harness";
import { ProjectService } from "../project";
import { SessionRepository } from "../session";
import type { RpcContext } from "./context";
import { openRawEventSubscription } from "./session-stream";
import { streamToAsyncGenerator } from "./stream";

const orpc = implement(sessionContract).$context<RpcContext>();

export const sessionRouter = orpc.router({
  list: orpc.list.effect(function* ({ input }) {
    const repo = yield* SessionRepository;
    const sessions = yield* HarnessAgentSessionService;
    const records = yield* repo.list(input.projectId);
    // vibest's records are the authoritative list; merge live backend display
    // data (title/updatedAt) and derive transcriptMissing per record. A failed
    // lookup degrades to "unknown" so one bad session can't sink the whole list.
    return yield* Effect.forEach(
      records,
      (record) =>
        Effect.gen(function* () {
          if (!record.harnessSessionId) return { ...record, transcriptMissing: false };
          const info = yield* sessions
            .getSessionInfo(record.harnessAgentId, record.harnessSessionId, record.cwd)
            .pipe(Effect.catch(() => Effect.succeed({ _tag: "unsupported" as const })));
          return info._tag === "found"
            ? { ...record, ...info.info, transcriptMissing: false }
            : { ...record, transcriptMissing: info._tag === "missing" };
        }),
      { concurrency: "unbounded" },
    );
  }),
  create: orpc.create.effect(function* ({ input }) {
    const sessions = yield* HarnessAgentSessionService;
    const workspacePath = input.workspacePath ?? process.cwd();
    const result = yield* sessions.create(input.harnessAgentId, { workspacePath });
    // Persist a record under its owning project so the session survives restarts
    // and can be listed/resumed. A session opened against a path that isn't a
    // registered project isn't persisted — there's no project to list it under.
    const projects = yield* ProjectService;
    const project = yield* projects.findByPath(workspacePath);
    if (project) {
      const repo = yield* SessionRepository;
      yield* repo.save({
        sessionId: result.sessionId,
        harnessSessionId: result.harnessSessionId,
        harnessAgentId: result.harnessAgentId,
        projectId: project.id,
        cwd: workspacePath,
        archived: false,
        createdAt: new Date().toISOString(),
      });
    }
    return result;
  }),
  resume: orpc.resume.effect(function* ({ input }) {
    const sessions = yield* HarnessAgentSessionService;
    // The caller resumes a listed session, so it already carries the backend id.
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
