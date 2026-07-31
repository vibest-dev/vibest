import assert from "node:assert/strict";
import path from "node:path";

import { layer } from "@effect/vitest";
import { isSessionScopedEvent } from "@vibest/contract";
import { Context, Effect, FileSystem, Layer, Stream } from "effect";

import { layerPaths } from "../src/config/paths";
import { AgentUnavailable } from "../src/errors";
import { EventBus, EventBusLayer } from "../src/events";
import type { SessionInfoResult } from "../src/harness";
import { ProjectRepositoryLayer } from "../src/project/repository";
import { ProjectService, ProjectServiceLayer } from "../src/project/service";
import { type HarnessCreateError, HarnessAgentSessionPort } from "../src/session/port";
import { SessionRepository, SessionRepositoryLayer } from "../src/session/repository";
import { SessionManagerLayer } from "../src/session/runtime";
import { SessionService, SessionServiceLayer } from "../src/session/service";
import { NodePlatformLayer } from "./platform";

type PortSpy = {
  create: Array<{ harnessAgentId: string; cwd: string }>;
  resume: Array<{ harnessAgentId: string; harnessSessionId: string; cwd: string }>;
  close: Array<string>;
};

const makeFakePort = (
  opts: { failCreate?: HarnessCreateError; sessionInfo?: SessionInfoResult } = {},
) => {
  const spy: PortSpy = { create: [], resume: [], close: [] };
  // Spy side effects live inside the effects (not at construction): callers
  // may build an effect without running it — e.g. the `onCrash` handed to the
  // runtime — and only executions should be counted.
  const portLayer = Layer.succeed(HarnessAgentSessionPort, {
    create: (harnessAgentId, cwd) =>
      Effect.suspend(() => {
        spy.create.push({ harnessAgentId, cwd });
        return opts.failCreate
          ? Effect.fail(opts.failCreate)
          : Effect.succeed(`native-${spy.create.length}`);
      }),
    resume: (harnessAgentId, harnessSessionId, cwd) =>
      Effect.sync(() => {
        spy.resume.push({ harnessAgentId, harnessSessionId, cwd });
      }),
    close: (harnessSessionId) =>
      Effect.sync(() => {
        spy.close.push(harnessSessionId);
      }),
    // A started session drains an empty native stream — enough to exercise the
    // create/resume → runtime-start path without any active-instance ops.
    events: () => Effect.succeed(Stream.empty),
    getSessionInfo: () =>
      Effect.succeed<SessionInfoResult>(opts.sessionInfo ?? { _tag: "unsupported" }),
    prompt: () => Effect.succeed({ turnId: "turn-1" }),
    interrupt: () => Effect.die("interrupt not exercised"),
    setModel: () => Effect.die("setModel not exercised"),
    setReasoningEffort: () => Effect.die("setReasoningEffort not exercised"),
    setPermissionMode: () => Effect.die("setPermissionMode not exercised"),
    respondToAgentRequest: () => Effect.die("respond not exercised"),
  });
  return { portLayer, spy };
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const APP = { name: "app", path: "/tmp/vibest-app" };
const APP_CWD = path.resolve(APP.path);

layer(NodePlatformLayer)("SessionService", (it) => {
  /**
   * A whole session stack over a fresh `$VIBEST_HOME` and a fake harness port,
   * built inside the test so each one is isolated and the scope tears it down.
   */
  const world = (opts: Parameters<typeof makeFakePort>[0] = {}) =>
    Effect.gen(function* () {
      const { portLayer, spy } = makeFakePort(opts);
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "vibest-svc-" });

      // Paths plus the platform services the repositories' JSON store runs on;
      // one reference, so the repositories share the same temp-dir wiring.
      const paths = Layer.provideMerge(layerPaths(home), NodePlatformLayer);
      const base = Layer.mergeAll(
        ProjectServiceLayer.pipe(Layer.provide(ProjectRepositoryLayer), Layer.provide(paths)),
        SessionRepositoryLayer.pipe(Layer.provide(paths)),
        SessionManagerLayer.pipe(Layer.provide(EventBusLayer)),
        EventBusLayer,
        NodePlatformLayer,
        portLayer,
      );
      // `base` is one reference, so its layers build once (shared temp dir).
      const context = yield* Layer.build(
        Layer.mergeAll(SessionServiceLayer.pipe(Layer.provide(base)), base),
      );
      return {
        spy,
        projects: Context.get(context, ProjectService),
        sessions: Context.get(context, SessionService),
        repo: Context.get(context, SessionRepository),
        bus: Context.get(context, EventBus),
      };
    });

  it.effect("create resolves projectId to cwd, generates a uuid sessionId, persists metadata", () =>
    Effect.gen(function* () {
      const { projects, sessions, repo, spy } = yield* world();
      const project = yield* projects.create(APP);
      const ref = yield* sessions.create(project.id, "claude-code");

      assert.equal(ref.projectId, project.id);
      assert.equal(ref.harnessAgentId, "claude-code");
      assert.match(ref.sessionId, UUID_RE);
      // harness saw the resolved cwd, never a projectId
      assert.deepEqual(spy.create, [{ harnessAgentId: "claude-code", cwd: APP_CWD }]);

      // metadata stores the native id, keyed by the server sessionId (filename)
      const stored = yield* repo.read(ref.projectId, ref.sessionId);
      assert.equal(stored.harnessSessionId, "native-1");
      assert.equal(stored.projectId, project.id);
    }),
  );

  it.effect("create fails with ProjectNotFound for an unknown projectId", () =>
    Effect.gen(function* () {
      const { sessions, spy } = yield* world();
      const error = yield* Effect.flip(
        sessions.create("00000000-0000-7000-8000-000000000000", "codex"),
      );
      assert.equal(error._tag, "ProjectNotFound");
      assert.equal(spy.create.length, 0);
    }),
  );

  it.effect("create surfaces AgentUnavailable and writes no metadata", () =>
    Effect.gen(function* () {
      const { projects, sessions, repo } = yield* world({
        failCreate: new AgentUnavailable({ harnessAgentId: "codex", reason: "not installed" }),
      });
      const project = yield* projects.create(APP);

      const error = yield* Effect.flip(sessions.create(project.id, "codex"));
      assert.equal(error._tag, "AgentUnavailable");
      assert.equal((yield* repo.list(project.id)).length, 0);
    }),
  );

  it.effect("resume translates the ref to the native id and passes the cwd", () =>
    Effect.gen(function* () {
      const { projects, sessions, spy } = yield* world();
      const project = yield* projects.create(APP);
      const ref = yield* sessions.create(project.id, "claude-code");
      yield* sessions.resume(ref);

      assert.deepEqual(spy.resume, [
        { harnessAgentId: "claude-code", harnessSessionId: "native-1", cwd: APP_CWD },
      ]);
    }),
  );

  it.effect("resume fails with SessionNotFound for an unknown session", () =>
    Effect.gen(function* () {
      const { projects, sessions } = yield* world();
      const project = yield* projects.create(APP);

      const error = yield* Effect.flip(
        sessions.resume({
          projectId: project.id,
          harnessAgentId: "claude-code",
          sessionId: "missing",
        }),
      );
      assert.equal(error._tag, "SessionNotFound");
    }),
  );

  it.effect(
    "resume fails with SessionRefMismatch when the ref's agent disagrees with metadata",
    () =>
      Effect.gen(function* () {
        const { projects, sessions } = yield* world();
        const project = yield* projects.create(APP);
        const ref = yield* sessions.create(project.id, "claude-code");

        const error = yield* Effect.flip(sessions.resume({ ...ref, harnessAgentId: "codex" }));
        assert.equal(error._tag, "SessionRefMismatch");
      }),
  );

  it.effect("close translates the ref to the native id", () =>
    Effect.gen(function* () {
      const { projects, sessions, spy } = yield* world();
      const project = yield* projects.create(APP);
      yield* sessions.close(yield* sessions.create(project.id, "claude-code"));

      assert.deepEqual(spy.close, ["native-1"]);
    }),
  );

  it.effect("delete closes the native session and removes its metadata", () =>
    Effect.gen(function* () {
      const { projects, sessions, spy } = yield* world();
      const project = yield* projects.create(APP);
      yield* sessions.delete(yield* sessions.create(project.id, "claude-code"));

      assert.deepEqual(spy.close, ["native-1"]);
      assert.equal((yield* sessions.list(project.id)).length, 0);
    }),
  );

  it.effect("list returns one summary per session, keyed by server sessionId", () =>
    Effect.gen(function* () {
      const { projects, sessions } = yield* world();
      const project = yield* projects.create(APP);
      const a = yield* sessions.create(project.id, "claude-code");
      const b = yield* sessions.create(project.id, "codex");

      const listed = yield* sessions.list(project.id);
      assert.equal(listed.length, 2);
      assert.deepEqual(
        listed.map((session) => session.sessionId).toSorted(),
        [a.sessionId, b.sessionId].toSorted(),
      );
      // We own the record, so a session we created reads as history-available.
      assert.ok(listed.every((session) => session.historyAvailable));
    }),
  );

  it.effect("titles a session from its first prompt, collapsing whitespace", () =>
    Effect.gen(function* () {
      const { projects, sessions } = yield* world();
      const project = yield* projects.create(APP);
      const ref = yield* sessions.create(project.id, "claude-code");
      yield* sessions.prompt({ ref, parts: [{ type: "text", text: "  Fix the  login  bug " }] });

      const listed = yield* sessions.list(project.id);
      assert.equal(listed.length, 1);
      assert.equal(listed[0]?.title, "Fix the login bug");
    }),
  );

  it.effect("publishes session.updated with the collapsed title on the first prompt", () =>
    Effect.gen(function* () {
      const { projects, sessions, bus } = yield* world();
      const project = yield* projects.create(APP);
      const ref = yield* sessions.create(project.id, "claude-code");

      // Subscribe after create so only the prompt's event is in flight; the
      // queue buffers it until take(1) pulls it — no forked drain, no race.
      const stream = yield* bus.subscribe({ kind: "global" });
      yield* sessions.prompt({ ref, parts: [{ type: "text", text: "  Fix the  login  bug " }] });
      const items = Array.from(yield* Stream.runCollect(Stream.take(stream, 1)));

      assert.equal(items.length, 1);
      const item = items[0];
      assert.equal(item?.type, "event");
      const event = item?.type === "event" ? item.event : undefined;
      assert.ok(event && !isSessionScopedEvent(event));
      assert.equal(event?.type, "session.updated");
      assert.equal(
        event?.type === "session.updated" ? event.title : undefined,
        "Fix the login bug",
      );
    }),
  );

  it.effect("keeps the first prompt's title; later prompts don't rename", () =>
    Effect.gen(function* () {
      const { projects, sessions } = yield* world();
      const project = yield* projects.create(APP);
      const ref = yield* sessions.create(project.id, "claude-code");
      yield* sessions.prompt({ ref, parts: [{ type: "text", text: "first" }] });
      yield* sessions.prompt({ ref, parts: [{ type: "text", text: "second" }] });

      assert.equal((yield* sessions.list(project.id))[0]?.title, "first");
    }),
  );

  it.effect("lists a session with no title until its first prompt", () =>
    Effect.gen(function* () {
      const { projects, sessions } = yield* world();
      const project = yield* projects.create(APP);
      yield* sessions.create(project.id, "claude-code");

      const listed = yield* sessions.list(project.id);
      assert.equal(listed.length, 1);
      assert.equal(listed[0]?.title, undefined);
    }),
  );

  it.effect("list fails with ProjectNotFound for an unknown project", () =>
    Effect.gen(function* () {
      const { sessions } = yield* world();
      const error = yield* Effect.flip(sessions.list("00000000-0000-7000-8000-000000000000"));
      assert.equal(error._tag, "ProjectNotFound");
    }),
  );
});
