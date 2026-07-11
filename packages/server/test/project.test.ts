import { Effect, Layer } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  layerPaths,
  ProjectRepository,
  ProjectRepositoryLayer,
  ProjectService,
  ProjectServiceLayer,
} from "../src/index";

const makeLayer = (home: string) => {
  const repo = ProjectRepositoryLayer.pipe(Layer.provide(layerPaths(home)));
  return Layer.mergeAll(repo, ProjectServiceLayer.pipe(Layer.provide(repo)));
};

describe("ProjectService", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "vibest-proj-"));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const run = <A, E>(program: Effect.Effect<A, E, ProjectService | ProjectRepository>) =>
    Effect.runPromise(Effect.provide(program, makeLayer(home)));

  it("creates and persists a project, then lists it", async () => {
    const result = await run(
      Effect.gen(function* () {
        const svc = yield* ProjectService;
        const created = yield* svc.create({ name: "app", path: "/tmp/app" });
        const listed = yield* svc.list();
        return { created, listed };
      }),
    );
    expect(result.created.name).toBe("app");
    expect(result.listed).toHaveLength(1);
    expect(result.listed[0]?.id).toBe(result.created.id);
  });

  it("dedupes by resolved path (create twice returns same project)", async () => {
    const result = await run(
      Effect.gen(function* () {
        const svc = yield* ProjectService;
        const a = yield* svc.create({ name: "app", path: "/tmp/app" });
        const b = yield* svc.create({ name: "again", path: "/tmp/app/" });
        const listed = yield* svc.list();
        return { a, b, count: listed.length };
      }),
    );
    expect(result.b.id).toBe(result.a.id);
    expect(result.count).toBe(1);
  });

  it("findById fails with ProjectNotFound for an unknown id", async () => {
    const err = await run(
      Effect.flip(
        Effect.gen(function* () {
          const svc = yield* ProjectService;
          return yield* svc.findById("nope");
        }),
      ),
    );
    expect(err._tag).toBe("ProjectNotFound");
  });

  it("removes a project", async () => {
    const remaining = await run(
      Effect.gen(function* () {
        const svc = yield* ProjectService;
        const p = yield* svc.create({ name: "app", path: "/tmp/app" });
        yield* svc.remove(p.id);
        return yield* svc.list();
      }),
    );
    expect(remaining).toHaveLength(0);
  });

  it("refuses to remove a protected (playground) project", async () => {
    const err = await run(
      Effect.flip(
        Effect.gen(function* () {
          const repo = yield* ProjectRepository;
          yield* repo.save([
            {
              id: "playground",
              name: "playground",
              path: "/tmp/pg",
              createdAt: new Date().toISOString(),
              protected: true,
            },
          ]);
          const svc = yield* ProjectService;
          return yield* svc.remove("playground");
        }),
      ),
    );
    expect(err._tag).toBe("ProjectProtected");
  });
});
