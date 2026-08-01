import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Context, Effect, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type HarnessAgentSessionRepositoryShape,
  makeHarnessAgentSessionRepository,
} from "../../src/harness/session-repository";
import type { Session } from "../../src/types";
import { NodePlatformLayer } from "../platform";

// The repository is a private collaborator of the session service (no Context
// tag in production); the test wraps the factory in a local tag for wiring.
class SessionRepository extends Context.Service<
  SessionRepository,
  HarnessAgentSessionRepositoryShape
>()("test/SessionRepository") {}

const makeLayer = (home: string) =>
  Layer.effect(
    SessionRepository,
    makeHarnessAgentSessionRepository(path.join(home, "storage", "sessions")),
  ).pipe(Layer.provide(NodePlatformLayer));

const meta = (sessionId: string, projectId: string, harnessSessionId: string): Session => ({
  version: 1,
  sessionId,
  projectId,
  harnessAgentId: "claude-code",
  harnessSessionId,
  createdAt: "2026-07-16T00:00:00.000Z",
});

describe("SessionRepository", () => {
  let home: string;
  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "vibest-sess-"));
  });
  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  const run = <A, E>(program: Effect.Effect<A, E, SessionRepository>) =>
    Effect.runPromise(Effect.provide(program, makeLayer(home)));

  it("writes then reads back a session's metadata", async () => {
    const read = await run(
      Effect.gen(function* () {
        const repo = yield* SessionRepository;
        yield* repo.write(meta("sess-1", "proj-a", "claude-uuid-1"));
        return yield* repo.read("proj-a", "sess-1");
      }),
    );
    expect(read.sessionId).toBe("sess-1");
    expect(read.harnessSessionId).toBe("claude-uuid-1");
    expect(read.version).toBe(1);
  });

  it("persists at storage/sessions/<projectId>/<sessionId>.json, the filename being the only sessionId", async () => {
    await run(
      Effect.gen(function* () {
        const repo = yield* SessionRepository;
        yield* repo.write(meta("sess-1", "proj-a", "claude-uuid-1"));
      }),
    );
    const raw = JSON.parse(
      await fs.readFile(path.join(home, "storage", "sessions", "proj-a", "sess-1.json"), "utf8"),
    );
    expect(raw.version).toBe(1);
    expect(raw.data.projectId).toBe("proj-a");
    expect(raw.data).not.toHaveProperty("sessionId");
  });

  // Verbatim bytes from a real ~/.vibest record written before the body carried
  // a sessionId at all. Fabricating this input from the current Session type is
  // what let the missing field go unnoticed: it produced a record no historical
  // install ever wrote, and the schema then rejected every one that they did.
  const PRE_ENVELOPE_RECORD = `{"version":1,"projectId":"proj-a","harnessAgentId":"pi","harnessSessionId":"019fa463-cf81-73bd-999f-ffe6c5310d2e","createdAt":"2026-07-27T16:23:54.641Z"}`;

  it("reads a pre-envelope record with no sessionId in the body", async () => {
    const file = path.join(home, "storage", "sessions", "proj-a", "sess-1.json");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, PRE_ENVELOPE_RECORD, "utf8");

    const read = await run(
      Effect.gen(function* () {
        const repo = yield* SessionRepository;
        return yield* repo.read("proj-a", "sess-1");
      }),
    );
    // Recovered from the filename, which is where it lived back then.
    expect(read.sessionId).toBe("sess-1");
    expect(read.harnessSessionId).toBe("019fa463-cf81-73bd-999f-ffe6c5310d2e");

    // Adopted into envelope form on that first read.
    const raw = JSON.parse(await fs.readFile(file, "utf8"));
    expect(raw.version).toBe(1);
    expect(raw.data.harnessAgentId).toBe("pi");
  });

  it("a record that does carry sessionId in the body still reads, filename winning", async () => {
    // The intermediate generation: post-sessionId, pre-envelope. The body's
    // copy is ignored rather than trusted, so a drifted one cannot mislead.
    const file = path.join(home, "storage", "sessions", "proj-a", "sess-1.json");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      file,
      JSON.stringify({ ...meta("stale-id", "proj-a", "claude-uuid-1") }),
      "utf8",
    );

    const read = await run(
      Effect.gen(function* () {
        const repo = yield* SessionRepository;
        return yield* repo.read("proj-a", "sess-1");
      }),
    );
    expect(read.sessionId).toBe("sess-1");
    expect(read.harnessSessionId).toBe("claude-uuid-1");
  });

  it("lists all sessions of a project", async () => {
    const listed = await run(
      Effect.gen(function* () {
        const repo = yield* SessionRepository;
        yield* repo.write(meta("sess-1", "proj-a", "u1"));
        yield* repo.write(meta("sess-2", "proj-a", "u2"));
        yield* repo.write(meta("sess-3", "proj-b", "u3"));
        return yield* repo.list("proj-a");
      }),
    );
    expect(listed.map((session) => session.sessionId).toSorted()).toEqual(["sess-1", "sess-2"]);
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
        yield* repo.write(meta("sess-1", "proj-a", "u1"));
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
        yield* repo.write(meta("sess-1", "proj-a", "u1"));
        yield* repo.write(meta("sess-2", "proj-b", "u2"));
        return yield* repo.findBySessionId("sess-2");
      }),
    );
    expect(hit.projectId).toBe("proj-b");
    expect(hit.sessionId).toBe("sess-2");
    expect(hit.harnessSessionId).toBe("u2");
  });

  it("a corrupt record in another project does not break this project's list", async () => {
    const badFile = path.join(home, "storage", "sessions", "proj-b", "bad.json");
    await fs.mkdir(path.dirname(badFile), { recursive: true });
    await fs.writeFile(badFile, "{ not json", "utf8");

    const result = await run(
      Effect.gen(function* () {
        const repo = yield* SessionRepository;
        yield* repo.write(meta("sess-1", "proj-a", "u1"));
        const listedA = yield* repo.list("proj-a");
        const errorB = yield* Effect.flip(repo.list("proj-b"));
        return { listedA, errorB };
      }),
    );
    expect(result.listedA.map((session) => session.sessionId)).toEqual(["sess-1"]);
    expect(result.errorB._tag).toBe("StoreReadError");
  });

  it("malformed ids yield typed results, never defects", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* SessionRepository;
        yield* repo.write(meta("sess-1", "proj-a", "u1"));
        const readError = yield* Effect.flip(repo.read("..", "sess-1"));
        const findError = yield* Effect.flip(repo.findBySessionId("a/../b"));
        const listed = yield* repo.list("../proj-a");
        yield* repo.remove("..", ".."); // no-op, must not die
        return { readError, findError, listed };
      }),
    );
    expect(result.readError._tag).toBe("SessionNotFound");
    expect(result.findError._tag).toBe("SessionRefNotFound");
    expect(result.listed).toEqual([]);
  });

  it("findBySessionId fails with SessionRefNotFound for an unknown session", async () => {
    const err = await run(
      Effect.flip(
        Effect.gen(function* () {
          const repo = yield* SessionRepository;
          yield* repo.write(meta("sess-1", "proj-a", "u1"));
          return yield* repo.findBySessionId("ghost");
        }),
      ),
    );
    expect(err._tag).toBe("SessionRefNotFound");
  });
});
