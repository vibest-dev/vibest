import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { Effect, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  layerPaths,
  ProjectRepositoryLayer,
  ProjectService,
  ProjectServiceLayer,
} from "../src/index";

const makeLayer = (home: string) =>
  ProjectServiceLayer.pipe(Layer.provide(ProjectRepositoryLayer), Layer.provide(layerPaths(home)));

describe("ProjectService", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "vibest-proj-"));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const run = <A, E>(program: Effect.Effect<A, E, ProjectService>) =>
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

  it("reads a pre-envelope projects.json and adopts it into envelope form", async () => {
    const file = join(home, "storage", "projects.json");
    const project = { id: "p1", name: "app", path: "/tmp/app", createdAt: "2026-07-16T00:00:00Z" };
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify([project]), "utf8");

    const listed = await run(
      Effect.gen(function* () {
        const svc = yield* ProjectService;
        return yield* svc.list();
      }),
    );
    expect(listed).toEqual([project]);

    const raw = JSON.parse(await readFile(file, "utf8"));
    expect(raw.version).toBe(1);
    expect(raw.data).toEqual([project]);
  });

  it("remove fails with ProjectNotFound for an unknown id", async () => {
    const err = await run(
      Effect.flip(
        Effect.gen(function* () {
          const svc = yield* ProjectService;
          return yield* svc.remove("nope");
        }),
      ),
    );
    expect(err._tag).toBe("ProjectNotFound");
  });
});
