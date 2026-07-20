import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { layerPaths } from "../src/config/paths";
import { SessionRepository, SessionRepositoryLayer } from "../src/session/repository";
import type { Session } from "../src/types";

const makeLayer = (home: string) => SessionRepositoryLayer.pipe(Layer.provide(layerPaths(home)));

const meta = (projectId: string, harnessSessionId: string): Session => ({
  version: 1,
  projectId,
  harnessAgentId: "claude-code",
  harnessSessionId,
  createdAt: "2026-07-16T00:00:00.000Z",
});

describe("SessionRepository", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "vibest-sess-"));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const run = <A, E>(program: Effect.Effect<A, E, SessionRepository>) =>
    Effect.runPromise(Effect.provide(program, makeLayer(home)));

  it("writes then reads back a session's metadata", async () => {
    const read = await run(
      Effect.gen(function* () {
        const repo = yield* SessionRepository;
        yield* repo.write("sess-1", meta("proj-a", "claude-uuid-1"));
        return yield* repo.read("proj-a", "sess-1");
      }),
    );
    expect(read.harnessSessionId).toBe("claude-uuid-1");
    expect(read.version).toBe(1);
  });

  it("persists at storage/sessions/<projectId>/<sessionId>.json, sessionId only in filename", async () => {
    await run(
      Effect.gen(function* () {
        const repo = yield* SessionRepository;
        yield* repo.write("sess-1", meta("proj-a", "claude-uuid-1"));
      }),
    );
    const raw = JSON.parse(
      await readFile(join(home, "storage", "sessions", "proj-a", "sess-1.json"), "utf8"),
    );
    expect(raw).not.toHaveProperty("sessionId");
    expect(raw.projectId).toBe("proj-a");
  });

  it("lists all sessions of a project, keyed by filename sessionId", async () => {
    const listed = await run(
      Effect.gen(function* () {
        const repo = yield* SessionRepository;
        yield* repo.write("sess-1", meta("proj-a", "u1"));
        yield* repo.write("sess-2", meta("proj-a", "u2"));
        yield* repo.write("sess-3", meta("proj-b", "u3"));
        return yield* repo.list("proj-a");
      }),
    );
    expect(listed.map((entry) => entry.sessionId).toSorted()).toEqual(["sess-1", "sess-2"]);
  });

  it("list returns empty for a project with no session dir", async () => {
    const listed = await run(
      Effect.gen(function* () {
        const repo = yield* SessionRepository;
        return yield* repo.list("never-created");
      }),
    );
    expect(listed).toEqual([]);
  });

  it("read fails with SessionNotFound for an unknown session", async () => {
    const err = await run(
      Effect.flip(
        Effect.gen(function* () {
          const repo = yield* SessionRepository;
          return yield* repo.read("proj-a", "nope");
        }),
      ),
    );
    expect(err._tag).toBe("SessionNotFound");
  });

  it("remove is idempotent and deletes the file", async () => {
    const listedAfter = await run(
      Effect.gen(function* () {
        const repo = yield* SessionRepository;
        yield* repo.write("sess-1", meta("proj-a", "u1"));
        yield* repo.remove("proj-a", "sess-1");
        yield* repo.remove("proj-a", "sess-1"); // idempotent: second remove is a no-op
        return yield* repo.list("proj-a");
      }),
    );
    expect(listedAfter).toEqual([]);
  });

  it("findBySessionId reverse-looks-up a session across projects", async () => {
    const hit = await run(
      Effect.gen(function* () {
        const repo = yield* SessionRepository;
        yield* repo.write("sess-1", meta("proj-a", "u1"));
        yield* repo.write("sess-2", meta("proj-b", "u2"));
        return yield* repo.findBySessionId("sess-2");
      }),
    );
    expect(hit.projectId).toBe("proj-b");
    expect(hit.metadata.harnessSessionId).toBe("u2");
  });

  it("findBySessionId fails with SessionRefNotFound for an unknown session", async () => {
    const err = await run(
      Effect.flip(
        Effect.gen(function* () {
          const repo = yield* SessionRepository;
          yield* repo.write("sess-1", meta("proj-a", "u1"));
          return yield* repo.findBySessionId("ghost");
        }),
      ),
    );
    expect(err._tag).toBe("SessionRefNotFound");
  });
});
