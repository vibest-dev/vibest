import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { Effect, Layer, ManagedRuntime } from "effect";
import { describe, expect, it } from "vitest";

import { BackendProcess, BackendProcessLive, resolveServerEntry } from "./backend";

function makeRuntime() {
  const nodeBase = Layer.merge(NodeFileSystem.layer, NodePath.layer);
  const spawner = NodeChildProcessSpawner.layer.pipe(Layer.provide(nodeBase));
  return ManagedRuntime.make(BackendProcessLive.pipe(Layer.provide(spawner)));
}

function makeScript(source: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "vibest-backend-test-"));
  const script = path.join(dir, "backend.mjs");
  writeFileSync(script, source);
  chmodSync(script, 0o755);
  return script;
}

const config = (entry: string) => ({
  entry,
  token: "test-token",
  shellPath: undefined,
  corsOrigins: ["vibest://app"],
});

describe("resolveServerEntry", () => {
  it("points at the collected server dependency in a packaged app", () => {
    const entry = resolveServerEntry(true, "/Applications/Vibest.app/Contents/Resources");
    expect(entry).toBe(
      path.join(
        "/Applications/Vibest.app/Contents/Resources",
        "app.asar",
        "node_modules",
        "@vibest",
        "cli",
        "dist",
        "cli.mjs",
      ),
    );
  });

  it("points at the monorepo build when unpackaged", () => {
    const entry = resolveServerEntry(false, "/unused");
    expect(entry).toMatch(/packages[/\\]vibest[/\\]dist[/\\]cli\.mjs$/);
  });
});

describe("BackendProcess", () => {
  it("reads a ready line split across stdout chunks", async () => {
    const entry = makeScript(`
process.stdout.write("ordinary log\\n");
process.stdout.write("vibest:rea");
setTimeout(() => process.stdout.write('dy {"port":43123}\\n'), 5);
setInterval(() => {}, 1000);
`);
    const runtime = makeRuntime();

    try {
      const port = await runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const backend = yield* BackendProcess;
            const running = yield* backend.launch(config(entry), 0);
            return yield* running.ready;
          }),
        ),
      );
      expect(port).toBe(43_123);
    } finally {
      await runtime.dispose();
    }
  });

  it("reports an exit before ready as a typed startup failure", async () => {
    const entry = makeScript("process.exit(7);\n");
    const runtime = makeRuntime();

    try {
      await expect(
        runtime.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const backend = yield* BackendProcess;
              const running = yield* backend.launch(config(entry), 0);
              return yield* running.ready;
            }),
          ),
        ),
      ).rejects.toMatchObject({ _tag: "BackendExitedBeforeReady", exitCode: 7 });
    } finally {
      await runtime.dispose();
    }
  });

  it("terminates the child when its process scope closes", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "vibest-backend-finalizer-"));
    const marker = path.join(dir, "terminated");
    const entry = makeScript(`
import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => {
  writeFileSync(${JSON.stringify(marker)}, "yes");
  process.exit(0);
});
process.stdout.write('vibest:ready {"port":43124}\\n');
setInterval(() => {}, 1000);
`);
    const runtime = makeRuntime();

    try {
      await runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const backend = yield* BackendProcess;
            const running = yield* backend.launch(config(entry), 0);
            yield* running.ready;
          }),
        ),
      );

      for (let attempt = 0; attempt < 100 && !existsSync(marker); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(existsSync(marker)).toBe(true);
    } finally {
      await runtime.dispose();
    }
  });
});
