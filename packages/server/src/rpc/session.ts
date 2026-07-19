import "@orpc/experimental-effect/extensions/effect";
import { resolve } from "node:path";

import { implement } from "@orpc/server";
import { sessionContract } from "@vibest/contract/session";
import { HarnessAgentSessionService } from "@vibest/harness/runtime";
import { Effect, Stream } from "effect";

import { EventBus } from "../events";
import { ProjectService } from "../project";
import { SessionRepository } from "../session";
import type { RpcContext } from "./context";
import { openRawEventSubscription } from "./session-stream";
import { streamToAsyncGenerator } from "./stream";

const orpc = implement(sessionContract).$context<RpcContext>();

/** The registered project whose folder a session was opened against, if any. */
const projectForPath = (workspacePath: string) =>
  Effect.gen(function* () {
    const projects = yield* ProjectService;
    const all = yield* projects.list();
    const target = resolve(workspacePath);
    return all.find((p) => resolve(p.path) === target);
  });

export const sessionRouter = orpc.router({
  list: orpc.list.effect(function* ({ input }) {
    const repo = yield* SessionRepository;
    const sessions = yield* HarnessAgentSessionService;
    const records = yield* repo.list(input.projectId);
    // vibest's records are the authoritative list; merge live backend display
    // data (title/updatedAt) and derive harnessMissing per record. A failed
    // lookup degrades to "unknown" so one bad session can't sink the whole list.
    return yield* Effect.forEach(
      records,
      (record) =>
        Effect.gen(function* () {
          if (!record.harnessSessionId) return { ...record, harnessMissing: false };
          const info = yield* sessions
            .getSessionInfo(record.harnessAgentId, record.harnessSessionId, record.cwd)
            .pipe(Effect.catch(() => Effect.succeed({ _tag: "unsupported" as const })));
          return info._tag === "found"
            ? { ...record, ...info.info, harnessMissing: false }
            : { ...record, harnessMissing: info._tag === "missing" };
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
    const project = yield* projectForPath(workspacePath);
    if (project && result.harnessSessionId) {
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
    // Adapters resume by backend id. Prefer the caller's harnessSessionId, else
    // recover it from the persisted record via the session's workspace path.
    let harnessSessionId = input.harnessSessionId;
    if (!harnessSessionId && input.workspacePath) {
      const project = yield* projectForPath(input.workspacePath);
      if (project) {
        const repo = yield* SessionRepository;
        const record = yield* repo.get(project.id, input.sessionId);
        harnessSessionId = record?.harnessSessionId;
      }
    }
    yield* sessions.resume({ ...input, harnessSessionId });
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
