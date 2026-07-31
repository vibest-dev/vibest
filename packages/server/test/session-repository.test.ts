import assert from "node:assert/strict";
import path from "node:path";

import { layer } from "@effect/vitest";
import { Context, Effect, FileSystem, Layer } from "effect";

import { layerPaths } from "../src/config/paths";
import { SessionRepository, SessionRepositoryLayer } from "../src/session/repository";
import type { Session } from "../src/types";
import { NodePlatformLayer } from "./platform";

const meta = (sessionId: string, projectId: string, harnessSessionId: string): Session => ({
  version: 1,
  sessionId,
  projectId,
  harnessAgentId: "claude-code",
  harnessSessionId,
  createdAt: "2026-07-16T00:00:00.000Z",
});

const sessionFile = (home: string, projectId: string, sessionId: string) =>
  path.join(home, "storage", "sessions", projectId, `${sessionId}.json`);

layer(NodePlatformLayer)("SessionRepository", (it) => {
  const tempHome = FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.makeTempDirectoryScoped({ prefix: "vibest-sess-" })),
  );

  // Kept separate from `tempHome` so the tests that seed a record on disk can
  // write it before the repository is built, as a real cold start would.
  const repositoryIn = (home: string) =>
    Layer.build(
      SessionRepositoryLayer.pipe(
        Layer.provide(layerPaths(home)),
        Layer.provide(NodePlatformLayer),
      ),
    ).pipe(Effect.map((context) => Context.get(context, SessionRepository)));

  const repository = Effect.flatMap(tempHome, repositoryIn);

  it.effect("writes then reads back a session's metadata", () =>
    Effect.gen(function* () {
      const repo = yield* repository;
      yield* repo.write(meta("sess-1", "proj-a", "claude-uuid-1"));

      const read = yield* repo.read("proj-a", "sess-1");
      assert.equal(read.sessionId, "sess-1");
      assert.equal(read.harnessSessionId, "claude-uuid-1");
      assert.equal(read.version, 1);
    }),
  );

  it.effect(
    "persists at storage/sessions/<projectId>/<sessionId>.json, sessionId in the body too",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* tempHome;
        const repo = yield* repositoryIn(home);
        yield* repo.write(meta("sess-1", "proj-a", "claude-uuid-1"));

        const raw = JSON.parse(yield* fs.readFileString(sessionFile(home, "proj-a", "sess-1")));
        assert.equal(raw.version, 1);
        assert.equal(raw.data.sessionId, "sess-1");
        assert.equal(raw.data.projectId, "proj-a");
      }),
  );

  it.effect("reads a pre-envelope record and adopts it into envelope form", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* tempHome;
      const file = sessionFile(home, "proj-a", "sess-1");
      yield* fs.makeDirectory(path.dirname(file), { recursive: true });
      yield* fs.writeFileString(file, JSON.stringify(meta("sess-1", "proj-a", "claude-uuid-1")));

      const repo = yield* repositoryIn(home);
      assert.equal((yield* repo.read("proj-a", "sess-1")).harnessSessionId, "claude-uuid-1");

      const raw = JSON.parse(yield* fs.readFileString(file));
      assert.equal(raw.version, 1);
      assert.equal(raw.data.sessionId, "sess-1");
    }),
  );

  it.effect("lists all sessions of a project", () =>
    Effect.gen(function* () {
      const repo = yield* repository;
      yield* repo.write(meta("sess-1", "proj-a", "u1"));
      yield* repo.write(meta("sess-2", "proj-a", "u2"));
      yield* repo.write(meta("sess-3", "proj-b", "u3"));

      const listed = yield* repo.list("proj-a");
      assert.deepEqual(listed.map((session) => session.sessionId).toSorted(), ["sess-1", "sess-2"]);
    }),
  );

  it.effect("list returns empty for a project with no session dir", () =>
    Effect.gen(function* () {
      const repo = yield* repository;
      assert.deepEqual(yield* repo.list("never-created"), []);
    }),
  );

  it.effect("read fails with SessionNotFound for an unknown session", () =>
    Effect.gen(function* () {
      const repo = yield* repository;
      const error = yield* Effect.flip(repo.read("proj-a", "nope"));
      assert.equal(error._tag, "SessionNotFound");
    }),
  );

  it.effect("remove is idempotent and deletes the file", () =>
    Effect.gen(function* () {
      const repo = yield* repository;
      yield* repo.write(meta("sess-1", "proj-a", "u1"));
      yield* repo.remove("proj-a", "sess-1");
      yield* repo.remove("proj-a", "sess-1"); // idempotent: second remove is a no-op
      assert.deepEqual(yield* repo.list("proj-a"), []);
    }),
  );

  it.effect("findBySessionId reverse-looks-up a session across projects", () =>
    Effect.gen(function* () {
      const repo = yield* repository;
      yield* repo.write(meta("sess-1", "proj-a", "u1"));
      yield* repo.write(meta("sess-2", "proj-b", "u2"));

      const hit = yield* repo.findBySessionId("sess-2");
      assert.equal(hit.projectId, "proj-b");
      assert.equal(hit.sessionId, "sess-2");
      assert.equal(hit.harnessSessionId, "u2");
    }),
  );

  it.effect("a corrupt record in another project does not break this project's list", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* tempHome;
      const badFile = sessionFile(home, "proj-b", "bad");
      yield* fs.makeDirectory(path.dirname(badFile), { recursive: true });
      yield* fs.writeFileString(badFile, "{ not json");

      const repo = yield* repositoryIn(home);
      yield* repo.write(meta("sess-1", "proj-a", "u1"));

      const listedA = yield* repo.list("proj-a");
      assert.deepEqual(
        Array.from(listedA, (session) => session.sessionId),
        ["sess-1"],
      );
      assert.equal((yield* Effect.flip(repo.list("proj-b")))._tag, "StoreReadError");
    }),
  );

  it.effect("malformed ids yield typed results, never defects", () =>
    Effect.gen(function* () {
      const repo = yield* repository;
      yield* repo.write(meta("sess-1", "proj-a", "u1"));

      assert.equal((yield* Effect.flip(repo.read("..", "sess-1")))._tag, "SessionNotFound");
      assert.equal((yield* Effect.flip(repo.findBySessionId("a/../b")))._tag, "SessionRefNotFound");
      assert.deepEqual(yield* repo.list("../proj-a"), []);
      yield* repo.remove("..", ".."); // no-op, must not die
    }),
  );

  it.effect("findBySessionId fails with SessionRefNotFound for an unknown session", () =>
    Effect.gen(function* () {
      const repo = yield* repository;
      yield* repo.write(meta("sess-1", "proj-a", "u1"));
      const error = yield* Effect.flip(repo.findBySessionId("ghost"));
      assert.equal(error._tag, "SessionRefNotFound");
    }),
  );
});
