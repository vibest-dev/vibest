import assert from "node:assert/strict";
import path from "node:path";

import { layer } from "@effect/vitest";
import { Context, Effect, Fiber, FileSystem, Layer, Stream } from "effect";

import { layerPaths } from "../src/config/paths";
import { ProjectRepositoryLayer, ProjectService, ProjectServiceLayer } from "../src/project";
import {
  PTY_PROJECT_LIMIT,
  PtyManagerLayer,
  PtyService,
  PtyServiceLayer,
  PtySpawner,
  type SpawnedPty,
} from "../src/pty";
import { NodePlatformLayer } from "./platform";

type FakePty = SpawnedPty & {
  readonly writes: string[];
  readonly sizes: Array<{ cols: number; rows: number }>;
  killed: boolean;
  emitData: (data: string) => void;
  emitExit: (exitCode: number) => void;
};

const makeFakePty = (): FakePty => {
  let onData: ((data: string) => void) | undefined;
  let onExit: ((exitCode: number) => void) | undefined;
  const fake: FakePty = {
    writes: [],
    sizes: [],
    killed: false,
    write: (data) => {
      fake.writes.push(data);
    },
    resize: (cols, rows) => {
      fake.sizes.push({ cols, rows });
    },
    kill: () => {
      fake.killed = true;
    },
    subscribe: (nextData, nextExit) => {
      onData = nextData;
      onExit = nextExit;
      return () => {
        onData = undefined;
        onExit = undefined;
      };
    },
    emitData: (data) => onData?.(data),
    emitExit: (exitCode) => onExit?.(exitCode),
  };
  return fake;
};

layer(NodePlatformLayer)("PtyService", (it) => {
  const tempHome = FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.makeTempDirectoryScoped({ prefix: "vibest-pty-" })),
  );

  const harness = Effect.gen(function* () {
    const home = yield* tempHome;
    const spawned: FakePty[] = [];
    const fakeSpawner = Layer.sync(PtySpawner, () => ({
      spawn: () =>
        Effect.sync(() => {
          const pty = makeFakePty();
          spawned.push(pty);
          return pty;
        }),
    }));
    const projectLayer = ProjectServiceLayer.pipe(
      Layer.provide(ProjectRepositoryLayer),
      Layer.provide(layerPaths(home)),
      Layer.provide(NodePlatformLayer),
    );
    const context = yield* Layer.build(
      Layer.mergeAll(
        projectLayer,
        PtyServiceLayer.pipe(
          Layer.provide(
            PtyManagerLayer.pipe(Layer.provide(fakeSpawner), Layer.provide(NodePlatformLayer)),
          ),
          Layer.provide(projectLayer),
        ),
      ),
    );
    return {
      spawned,
      projects: Context.get(context, ProjectService),
      ptys: Context.get(context, PtyService),
    };
  });

  it.effect("creates, lists, writes, resizes, and deletes a pty for a project", () =>
    Effect.gen(function* () {
      const { spawned, projects, ptys } = yield* harness;
      const project = yield* projects.create({ path: path.join("/tmp", "pty-workspace") });
      const created = yield* ptys.create({ projectId: project.id, cols: 80, rows: 24 });
      assert.equal(created.projectId, project.id);
      assert.equal((yield* ptys.list(project.id)).length, 1);
      assert.equal((yield* ptys.get(created.ptyId)).ptyId, created.ptyId);

      yield* ptys.write(created.ptyId, "ls\n");
      yield* ptys.resize(created.ptyId, 100, 30);
      assert.deepEqual(spawned[0]?.writes, ["ls\n"]);
      assert.deepEqual(spawned[0]?.sizes, [{ cols: 100, rows: 30 }]);
      assert.equal((yield* ptys.get(created.ptyId)).cols, 100);

      yield* ptys.delete(created.ptyId);
      assert.equal(spawned[0]?.killed, true);
      const missing = yield* Effect.flip(ptys.get(created.ptyId));
      assert.equal(missing._tag, "PtyNotFound");
    }),
  );

  it.effect("rejects an unknown project and unknown pty id", () =>
    Effect.gen(function* () {
      const { ptys } = yield* harness;
      const missingProject = yield* Effect.flip(
        ptys.create({ projectId: "00000000-0000-4000-8000-000000000000", cols: 80, rows: 24 }),
      );
      assert.equal(missingProject._tag, "ProjectNotFound");
      const missingPty = yield* Effect.flip(ptys.write("missing", "x"));
      assert.equal(missingPty._tag, "PtyNotFound");
    }),
  );

  it.effect("enforces the per-project cap", () =>
    Effect.gen(function* () {
      const { projects, ptys } = yield* harness;
      const project = yield* projects.create({ path: path.join("/tmp", "pty-cap") });
      for (let i = 0; i < PTY_PROJECT_LIMIT; i += 1) {
        yield* ptys.create({ projectId: project.id, cols: 80, rows: 24 });
      }
      const error = yield* Effect.flip(ptys.create({ projectId: project.id, cols: 80, rows: 24 }));
      assert.equal(error._tag, "PtyLimitReached");
      assert.equal(error.limit, PTY_PROJECT_LIMIT);
    }),
  );

  it.effect("fans output to a subscriber and ends on exit", () =>
    Effect.gen(function* () {
      const { spawned, projects, ptys } = yield* harness;
      const project = yield* projects.create({ path: path.join("/tmp", "pty-sub") });
      const created = yield* ptys.create({ projectId: project.id, cols: 80, rows: 24 });
      const stream = yield* ptys.subscribe(created.ptyId);
      const fiber = yield* Effect.forkChild(Stream.runCollect(stream));
      spawned[0]?.emitData("hello");
      spawned[0]?.emitExit(0);
      const events = yield* Fiber.join(fiber);
      assert.deepEqual(events, [
        { type: "data", data: "hello" },
        { type: "exit", exitCode: 0 },
      ]);
    }),
  );
});
