import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { isSessionScopedEvent } from "@vibest/contract";
import { Effect, Layer, Stream } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
  const layer = Layer.succeed(HarnessAgentSessionPort, {
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
  return { layer, spy };
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("SessionService", () => {
  let home: string;
  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "vibest-svc-"));
  });
  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  const layers = (port: Layer.Layer<HarnessAgentSessionPort>) => {
    const paths = layerPaths(home);
    const base = Layer.mergeAll(
      ProjectServiceLayer.pipe(Layer.provide(ProjectRepositoryLayer), Layer.provide(paths)),
      SessionRepositoryLayer.pipe(Layer.provide(paths)),
      SessionManagerLayer.pipe(Layer.provide(EventBusLayer)),
      EventBusLayer,
      port,
    );
    // Expose SessionService plus the base services the programs also read from;
    // `base` is one reference, so its layers build once (shared temp dir).
    return Layer.mergeAll(SessionServiceLayer.pipe(Layer.provide(base)), base);
  };

  const run = <A, E>(
    port: Layer.Layer<HarnessAgentSessionPort>,
    program: Effect.Effect<A, E, SessionService | ProjectService | SessionRepository | EventBus>,
  ) => Effect.runPromise(Effect.provide(program, layers(port)));

  it("create resolves projectId to cwd, generates a uuid sessionId, persists metadata", async () => {
    const { layer, spy } = makeFakePort();
    const result = await run(
      layer,
      Effect.gen(function* () {
        const projects = yield* ProjectService;
        const sessions = yield* SessionService;
        const repo = yield* SessionRepository;
        const project = yield* projects.create({ name: "app", path: "/tmp/vibest-app" });
        const ref = yield* sessions.create(project.id, "claude-code");
        const stored = yield* repo.read(ref.projectId, ref.sessionId);
        return { project, ref, stored };
      }),
    );

    expect(result.ref.projectId).toBe(result.project.id);
    expect(result.ref.harnessAgentId).toBe("claude-code");
    expect(result.ref.sessionId).toMatch(UUID_RE);
    // harness saw the resolved cwd, never a projectId
    expect(spy.create).toEqual([
      { harnessAgentId: "claude-code", cwd: path.resolve("/tmp/vibest-app") },
    ]);
    // metadata stores the native id, keyed by the server sessionId (filename)
    expect(result.stored.harnessSessionId).toBe("native-1");
    expect(result.stored.projectId).toBe(result.project.id);
  });

  it("create fails with ProjectNotFound for an unknown projectId", async () => {
    const { layer, spy } = makeFakePort();
    const err = await run(
      layer,
      Effect.flip(
        Effect.gen(function* () {
          const sessions = yield* SessionService;
          return yield* sessions.create("00000000-0000-7000-8000-000000000000", "codex");
        }),
      ),
    );
    expect(err._tag).toBe("ProjectNotFound");
    expect(spy.create).toHaveLength(0);
  });

  it("create surfaces AgentUnavailable and writes no metadata", async () => {
    const { layer } = makeFakePort({
      failCreate: new AgentUnavailable({ harnessAgentId: "codex", reason: "not installed" }),
    });
    const result = await run(
      layer,
      Effect.gen(function* () {
        const projects = yield* ProjectService;
        const sessions = yield* SessionService;
        const repo = yield* SessionRepository;
        const project = yield* projects.create({ name: "app", path: "/tmp/vibest-app" });
        const err = yield* Effect.flip(sessions.create(project.id, "codex"));
        const listed = yield* repo.list(project.id);
        return { err, listed };
      }),
    );
    expect(result.err._tag).toBe("AgentUnavailable");
    expect(result.listed).toHaveLength(0);
  });

  it("resume translates the ref to the native id and passes the cwd", async () => {
    const { layer, spy } = makeFakePort();
    await run(
      layer,
      Effect.gen(function* () {
        const projects = yield* ProjectService;
        const sessions = yield* SessionService;
        const project = yield* projects.create({ name: "app", path: "/tmp/vibest-app" });
        const ref = yield* sessions.create(project.id, "claude-code");
        yield* sessions.resume(ref);
      }),
    );
    expect(spy.resume).toEqual([
      {
        harnessAgentId: "claude-code",
        harnessSessionId: "native-1",
        cwd: path.resolve("/tmp/vibest-app"),
      },
    ]);
  });

  it("resume fails with SessionNotFound for an unknown session", async () => {
    const { layer } = makeFakePort();
    const err = await run(
      layer,
      Effect.gen(function* () {
        const projects = yield* ProjectService;
        const sessions = yield* SessionService;
        const project = yield* projects.create({ name: "app", path: "/tmp/vibest-app" });
        return yield* Effect.flip(
          sessions.resume({
            projectId: project.id,
            harnessAgentId: "claude-code",
            sessionId: "missing",
          }),
        );
      }),
    );
    expect(err._tag).toBe("SessionNotFound");
  });

  it("resume fails with SessionRefMismatch when the ref's agent disagrees with metadata", async () => {
    const { layer } = makeFakePort();
    const err = await run(
      layer,
      Effect.gen(function* () {
        const projects = yield* ProjectService;
        const sessions = yield* SessionService;
        const project = yield* projects.create({ name: "app", path: "/tmp/vibest-app" });
        const ref = yield* sessions.create(project.id, "claude-code");
        return yield* Effect.flip(sessions.resume({ ...ref, harnessAgentId: "codex" }));
      }),
    );
    expect(err._tag).toBe("SessionRefMismatch");
  });

  it("close translates the ref to the native id", async () => {
    const { layer, spy } = makeFakePort();
    await run(
      layer,
      Effect.gen(function* () {
        const projects = yield* ProjectService;
        const sessions = yield* SessionService;
        const project = yield* projects.create({ name: "app", path: "/tmp/vibest-app" });
        const ref = yield* sessions.create(project.id, "claude-code");
        yield* sessions.close(ref);
      }),
    );
    expect(spy.close).toEqual(["native-1"]);
  });

  it("delete closes the native session and removes its metadata", async () => {
    const { layer, spy } = makeFakePort();
    const listed = await run(
      layer,
      Effect.gen(function* () {
        const projects = yield* ProjectService;
        const sessions = yield* SessionService;
        const project = yield* projects.create({ name: "app", path: "/tmp/vibest-app" });
        const ref = yield* sessions.create(project.id, "claude-code");
        yield* sessions.delete(ref);
        return yield* sessions.list(project.id);
      }),
    );
    expect(spy.close).toEqual(["native-1"]);
    expect(listed).toHaveLength(0);
  });

  it("list returns one summary per session, keyed by server sessionId", async () => {
    const { layer } = makeFakePort();
    const result = await run(
      layer,
      Effect.gen(function* () {
        const projects = yield* ProjectService;
        const sessions = yield* SessionService;
        const project = yield* projects.create({ name: "app", path: "/tmp/vibest-app" });
        const a = yield* sessions.create(project.id, "claude-code");
        const b = yield* sessions.create(project.id, "codex");
        const listed = yield* sessions.list(project.id);
        return { a, b, listed };
      }),
    );
    expect(result.listed).toHaveLength(2);
    expect(result.listed.map((s) => s.sessionId).toSorted()).toEqual(
      [result.a.sessionId, result.b.sessionId].toSorted(),
    );
    // We own the record, so a session we created reads as history-available.
    expect(result.listed.every((s) => s.historyAvailable)).toBe(true);
  });

  it("titles a session from its first prompt, collapsing whitespace", async () => {
    const { layer } = makeFakePort();
    const listed = await run(
      layer,
      Effect.gen(function* () {
        const projects = yield* ProjectService;
        const sessions = yield* SessionService;
        const project = yield* projects.create({ name: "app", path: "/tmp/vibest-app" });
        const ref = yield* sessions.create(project.id, "claude-code");
        yield* sessions.prompt({ ref, parts: [{ type: "text", text: "  Fix the  login  bug " }] });
        return yield* sessions.list(project.id);
      }),
    );
    expect(listed).toHaveLength(1);
    expect(listed[0]?.title).toBe("Fix the login bug");
  });

  it("publishes session.updated with the collapsed title on the first prompt", async () => {
    const { layer } = makeFakePort();
    const result = await run(
      layer,
      Effect.gen(function* () {
        const projects = yield* ProjectService;
        const sessions = yield* SessionService;
        const bus = yield* EventBus;
        const project = yield* projects.create({ name: "app", path: "/tmp/vibest-app" });
        const ref = yield* sessions.create(project.id, "claude-code");
        // Subscribe after create so only the prompt's event is in flight; the
        // queue buffers it until take(1) pulls it — no forked drain, no race.
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const stream = yield* bus.subscribe({ kind: "global" });
            yield* sessions.prompt({
              ref,
              parts: [{ type: "text", text: "  Fix the  login  bug " }],
            });
            const items = yield* Stream.runCollect(Stream.take(stream, 1));
            return Array.from(items);
          }),
        );
      }),
    );
    expect(result).toHaveLength(1);
    const item = result[0];
    expect(item?.type).toBe("event");
    const event = item?.type === "event" ? item.event : undefined;
    expect(event && !isSessionScopedEvent(event)).toBe(true);
    expect(event?.type).toBe("session.updated");
    expect(event?.type === "session.updated" ? event.title : undefined).toBe("Fix the login bug");
  });

  it("keeps the first prompt's title; later prompts don't rename", async () => {
    const { layer } = makeFakePort();
    const listed = await run(
      layer,
      Effect.gen(function* () {
        const projects = yield* ProjectService;
        const sessions = yield* SessionService;
        const project = yield* projects.create({ name: "app", path: "/tmp/vibest-app" });
        const ref = yield* sessions.create(project.id, "claude-code");
        yield* sessions.prompt({ ref, parts: [{ type: "text", text: "first" }] });
        yield* sessions.prompt({ ref, parts: [{ type: "text", text: "second" }] });
        return yield* sessions.list(project.id);
      }),
    );
    expect(listed[0]?.title).toBe("first");
  });

  it("lists a session with no title until its first prompt", async () => {
    const { layer } = makeFakePort();
    const listed = await run(
      layer,
      Effect.gen(function* () {
        const projects = yield* ProjectService;
        const sessions = yield* SessionService;
        const project = yield* projects.create({ name: "app", path: "/tmp/vibest-app" });
        yield* sessions.create(project.id, "claude-code");
        return yield* sessions.list(project.id);
      }),
    );
    expect(listed).toHaveLength(1);
    expect(listed[0]?.title).toBeUndefined();
  });

  it("list fails with ProjectNotFound for an unknown project", async () => {
    const { layer } = makeFakePort();
    const err = await run(
      layer,
      Effect.flip(
        Effect.gen(function* () {
          const sessions = yield* SessionService;
          return yield* sessions.list("00000000-0000-7000-8000-000000000000");
        }),
      ),
    );
    expect(err._tag).toBe("ProjectNotFound");
  });
});
