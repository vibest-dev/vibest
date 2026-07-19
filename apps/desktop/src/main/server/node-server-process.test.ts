import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { Effect, Layer, ManagedRuntime } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect, it } from "vitest";

import type { ServerProcessConfig } from "./local-server";
import { makeNodeServerProcess } from "./node-server-process";

function makeRuntime() {
  const nodeBase = Layer.merge(NodeFileSystem.layer, NodePath.layer);
  const spawner = NodeChildProcessSpawner.layer.pipe(Layer.provide(nodeBase));
  return ManagedRuntime.make(spawner);
}

function makeScript(source: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "vibest-server-test-"));
  const script = path.join(dir, "server.mjs");
  writeFileSync(script, source);
  chmodSync(script, 0o755);
  return script;
}

const config = (entry: string): ServerProcessConfig => ({
  entry,
  token: "test-token",
  environment: {
    ...process.env,
    HTTPS_PROXY: "http://desktop-proxy.test:8443",
  },
  corsOrigins: ["vibest://app"],
});

describe("NodeServerProcess", () => {
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
            const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
            const running = yield* makeNodeServerProcess(spawner)(config(entry), 0);
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
              const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
              const running = yield* makeNodeServerProcess(spawner)(config(entry), 0);
              return yield* running.ready;
            }),
          ),
        ),
      ).rejects.toMatchObject({ _tag: "ServerExitedBeforeReady", exitCode: 7 });
    } finally {
      await runtime.dispose();
    }
  });

  it("resolves awaitExit with a null code when the server dies from a signal", async () => {
    const entry = makeScript('process.kill(process.pid, "SIGKILL");\n');
    const runtime = makeRuntime();

    try {
      const { exit, readyError } = await runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
            const running = yield* makeNodeServerProcess(spawner)(config(entry), 0);
            const exitValue = yield* running.awaitExit;
            const readyFailure = yield* Effect.flip(running.ready);
            return { exit: exitValue, readyError: readyFailure };
          }),
        ),
      );

      expect(exit).toEqual({ exitCode: null });
      expect(readyError).toMatchObject({ _tag: "ServerExitedBeforeReady", exitCode: null });
    } finally {
      await runtime.dispose();
    }
  });

  it("passes the configured proxy environment to the server process", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "vibest-server-env-"));
    const marker = path.join(dir, "proxy");
    const entry = makeScript(`
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, process.env.HTTPS_PROXY ?? "missing");
process.stdout.write('vibest:ready {"port":43125}\\n');
setInterval(() => {}, 1000);
`);
    const runtime = makeRuntime();

    try {
      await runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
            const running = yield* makeNodeServerProcess(spawner)(config(entry), 0);
            yield* running.ready;
          }),
        ),
      );

      expect(readFileSync(marker, "utf8")).toBe("http://desktop-proxy.test:8443");
    } finally {
      await runtime.dispose();
    }
  });

  it("terminates the child when its process scope closes", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "vibest-server-finalizer-"));
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
            const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
            const running = yield* makeNodeServerProcess(spawner)(config(entry), 0);
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
