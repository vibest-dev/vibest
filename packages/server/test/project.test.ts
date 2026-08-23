import assert from "node:assert/strict";
import path from "node:path";

import { layer } from "@effect/vitest";
import { Cause, Context, Crypto, Effect, Exit, FileSystem, Layer, PlatformError } from "effect";

import {
  layerPaths,
  ProjectRepositoryLayer,
  ProjectService,
  ProjectServiceLayer,
} from "../src/index";
import { NodePlatformLayer } from "./platform";

layer(NodePlatformLayer)("ProjectService", (it) => {
  const tempHome = FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.makeTempDirectoryScoped({ prefix: "vibest-proj-" })),
  );

  // Kept separate from `tempHome` so the two tests that seed a projects.json can
  // write it before the service is built, as a real cold start would.
  const serviceIn = (home: string) =>
    Layer.build(
      ProjectServiceLayer.pipe(
        Layer.provide(ProjectRepositoryLayer),
        Layer.provide(layerPaths(home)),
        Layer.provide(NodePlatformLayer),
      ),
    ).pipe(Effect.map((context) => Context.get(context, ProjectService)));

  const projects = Effect.flatMap(tempHome, serviceIn);

  it.effect("creates and persists a project, then lists it", () =>
    Effect.gen(function* () {
      const svc = yield* projects;
      const created = yield* svc.create({ name: "app", path: "/tmp/app" });

      const listed = yield* svc.list();
      assert.equal(created.name, "app");
      assert.equal(listed.length, 1);
      assert.equal(listed[0]?.id, created.id);
    }),
  );

  it.effect("dedupes by resolved path (create twice returns same project)", () =>
    Effect.gen(function* () {
      const svc = yield* projects;
      const a = yield* svc.create({ name: "app", path: "/tmp/app" });
      const b = yield* svc.create({ name: "again", path: "/tmp/app/" });

      assert.equal(b.id, a.id);
      assert.equal((yield* svc.list()).length, 1);
    }),
  );

  it.effect("findById fails with ProjectNotFound for an unknown id", () =>
    Effect.gen(function* () {
      const svc = yield* projects;
      const error = yield* Effect.flip(svc.findById("nope"));
      assert.equal(error._tag, "ProjectNotFound");
    }),
  );

  it.effect("removes a project", () =>
    Effect.gen(function* () {
      const svc = yield* projects;
      const project = yield* svc.create({ name: "app", path: "/tmp/app" });
      yield* svc.remove(project.id);
      assert.equal((yield* svc.list()).length, 0);
    }),
  );

  it.effect("reads a pre-envelope projects.json and adopts it into envelope form", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* tempHome;
      const file = path.join(home, "storage", "projects.json");
      const project = {
        id: "p1",
        name: "app",
        path: "/tmp/app",
        createdAt: "2026-07-16T00:00:00Z",
      };
      yield* fs.makeDirectory(path.dirname(file), { recursive: true });
      yield* fs.writeFileString(file, JSON.stringify([project]));

      const svc = yield* serviceIn(home);
      assert.deepEqual(yield* svc.list(), [project]);

      const raw = JSON.parse(yield* fs.readFileString(file));
      assert.equal(raw.version, 1);
      assert.deepEqual(raw.data, [project]);
    }),
  );

  it.effect(
    "a corrupt projects.json fails per call with StoreReadError and recovers once fixed",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* tempHome;
        const file = path.join(home, "storage", "projects.json");
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        yield* fs.writeFileString(file, "{ not json");

        // The layer must still build (no startup defect); the error is per call.
        const svc = yield* serviceIn(home);
        const error = yield* Effect.flip(svc.list());
        assert.equal(error._tag, "StoreReadError");

        // Fix the file on disk; the next call retries the open and recovers.
        yield* fs.writeFileString(file, "[]");
        assert.deepEqual(yield* svc.list(), []);
      }),
  );

  it.effect("remove fails with ProjectNotFound for an unknown id", () =>
    Effect.gen(function* () {
      const svc = yield* projects;
      const error = yield* Effect.flip(svc.remove("nope"));
      assert.equal(error._tag, "ProjectNotFound");
    }),
  );

  it.effect("an RNG failure minting a project id is a contextual defect, not a typed error", () =>
    Effect.gen(function* () {
      // The real Crypto with only `randomUUIDv4` broken: the service treats a
      // platform RNG failure as an invariant violation, so it must die with
      // the operation named — never leak into the typed error channel.
      const brokenCrypto = Layer.effect(
        Crypto.Crypto,
        Effect.gen(function* () {
          const real = yield* Crypto.Crypto;
          return {
            ...real,
            randomUUIDv4: Effect.fail(
              PlatformError.badArgument({ module: "Crypto", method: "randomUUIDv4" }),
            ),
          };
        }),
      ).pipe(Layer.provide(NodePlatformLayer));

      const home = yield* tempHome;
      const svc = yield* Layer.build(
        ProjectServiceLayer.pipe(
          Layer.provide(ProjectRepositoryLayer),
          Layer.provide(layerPaths(home)),
          Layer.provide(brokenCrypto),
          Layer.provide(NodePlatformLayer),
        ),
      ).pipe(Effect.map((context) => Context.get(context, ProjectService)));

      const exit = yield* Effect.exit(svc.create({ name: "app", path: "/tmp/app" }));
      assert.equal(Exit.isFailure(exit) && Cause.hasDies(exit.cause), true);
      assert.equal(Exit.isFailure(exit) && Cause.hasFails(exit.cause), false);
      const defect = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
      assert.ok(defect instanceof Error && defect.message.includes("project id"));
    }),
  );
});
