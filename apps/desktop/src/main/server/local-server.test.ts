import { Deferred, Effect, Exit, Scope } from "effect";
import { describe, expect, it } from "vitest";

import {
  ServerExitedBeforeReady,
  type ServerProcessConfig,
  type LocalServerConfig,
  type RunningServerProcess,
  type SpawnServer,
  makeLocalServer,
  restartBackoff,
} from "./local-server";

type FakeProcess = {
  readonly port: number;
  readonly config: ServerProcessConfig;
  readonly becomeReady: (port?: number) => void;
  readonly failBeforeReady: () => void;
  readonly exit: () => void;
  killed: boolean;
};

function makeHarness(overrides: Partial<LocalServerConfig> = {}) {
  const processes: FakeProcess[] = [];
  const scope = Effect.runSync(Scope.make());

  const spawnServer: SpawnServer = (config, port) =>
    Effect.gen(function* () {
      const ready = yield* Deferred.make<number, ServerExitedBeforeReady>();
      const exited = yield* Deferred.make<{ exitCode: number | null }>();
      const process: FakeProcess = {
        port,
        config,
        killed: false,
        becomeReady: (boundPort = port || 40_000) => {
          Effect.runSync(Deferred.succeed(ready, boundPort));
        },
        failBeforeReady: () => {
          Effect.runSync(
            Deferred.fail(
              ready,
              new ServerExitedBeforeReady({
                exitCode: 1,
                message: "exited before ready",
              }),
            ),
          );
        },
        exit: () => {
          Effect.runSync(Deferred.succeed(exited, { exitCode: 1 }));
        },
      };
      processes.push(process);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          process.killed = true;
        }),
      );
      return {
        ready: Deferred.await(ready),
        awaitExit: Deferred.await(exited),
      } satisfies RunningServerProcess;
    });

  const config: LocalServerConfig = {
    entry: "/fake/cli.mjs",
    token: "fixed-token",
    environment: Effect.succeed({
      PATH: "/login/bin:/usr/bin",
      HTTPS_PROXY: "http://proxy.test:8443",
    }),
    corsOrigins: ["vibest://app"],
    initialRestartDelayMs: 0,
    maxRestartDelayMs: 0,
    maxFastFailures: 5,
    stableAfterMs: 10_000,
    ...overrides,
  };

  return {
    processes,
    server: Effect.runPromise(makeLocalServer(config, spawnServer).pipe(Scope.provide(scope))),
    dispose: () => Effect.runPromise(Scope.close(scope, Exit.void)),
  };
}

async function eventually(assertion: () => void | Promise<void>): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  throw lastError;
}

describe("LocalServer", () => {
  it("returns while starting, then exposes the fixed connection after ready", async () => {
    const h = makeHarness();
    const server = await h.server;

    await expect(Effect.runPromise(server.snapshot)).resolves.toMatchObject({
      status: "starting",
    });
    await eventually(() => expect(h.processes[0]?.port).toBe(0));
    h.processes[0]!.becomeReady(56_789);

    await expect(Effect.runPromise(server.connection)).resolves.toEqual({
      httpBaseUrl: "http://127.0.0.1:56789",
      wsBaseUrl: "ws://127.0.0.1:56789",
      token: "fixed-token",
    });
    await expect(Effect.runPromise(server.snapshot)).resolves.toMatchObject({ status: "ready" });
    expect(h.processes[0]!.config.environment).toMatchObject({
      PATH: "/login/bin:/usr/bin",
      HTTPS_PROXY: "http://proxy.test:8443",
    });

    await h.dispose();
  });

  it("does not wait for environment resolution before exposing starting state", async () => {
    const environment = Effect.runSync(Deferred.make<NodeJS.ProcessEnv>());
    const h = makeHarness({ environment: Deferred.await(environment) });
    const server = await h.server;

    expect(h.processes).toHaveLength(0);
    await expect(Effect.runPromise(server.snapshot)).resolves.toMatchObject({
      status: "starting",
    });

    Effect.runSync(Deferred.succeed(environment, { PATH: "/usr/bin" }));
    await eventually(() => expect(h.processes).toHaveLength(1));
    h.processes[0]!.becomeReady(50_000);
    await Effect.runPromise(server.connection);
    await h.dispose();
  });

  it("surfaces an initial failure and retries without rebuilding the service", async () => {
    const h = makeHarness();
    const server = await h.server;

    await eventually(() => expect(h.processes).toHaveLength(1));
    h.processes[0]!.failBeforeReady();
    await eventually(async () => {
      expect((await Effect.runPromise(server.snapshot)).status).toBe("failed");
    });

    await Effect.runPromise(server.retry);
    await eventually(() => expect(h.processes).toHaveLength(2));
    expect(h.processes[1]!.port).toBe(0);
    h.processes[1]!.becomeReady(50_000);

    await expect(Effect.runPromise(server.connection)).resolves.toMatchObject({
      httpBaseUrl: "http://127.0.0.1:50000",
    });
    await h.dispose();
  });

  it("restarts on the same pinned port and keeps the token", async () => {
    const h = makeHarness();
    await eventually(() => expect(h.processes).toHaveLength(1));
    h.processes[0]!.becomeReady(50_000);
    const server = await h.server;
    await Effect.runPromise(server.connection);

    h.processes[0]!.exit();
    await eventually(() => expect(h.processes).toHaveLength(2));
    expect(h.processes[1]!.port).toBe(50_000);
    expect(h.processes[1]!.config.token).toBe("fixed-token");
    h.processes[1]!.becomeReady();
    await eventually(async () => {
      expect((await Effect.runPromise(server.snapshot)).status).toBe("ready");
    });

    await h.dispose();
  });

  it("enters failed after repeated crashes and retries only once", async () => {
    const h = makeHarness({ maxFastFailures: 2 });
    await eventually(() => expect(h.processes).toHaveLength(1));
    h.processes[0]!.becomeReady(50_000);
    const server = await h.server;
    await Effect.runPromise(server.connection);

    h.processes[0]!.exit();
    await eventually(() => expect(h.processes).toHaveLength(2));
    h.processes[1]!.failBeforeReady();
    await eventually(() => expect(h.processes).toHaveLength(3));
    h.processes[2]!.failBeforeReady();
    await eventually(async () => {
      expect((await Effect.runPromise(server.snapshot)).status).toBe("failed");
    });

    await Promise.all([
      Effect.runPromise(server.retry),
      Effect.runPromise(server.retry),
      Effect.runPromise(server.retry),
    ]);
    await eventually(() => expect(h.processes).toHaveLength(4));
    expect(h.processes[3]!.port).toBe(50_000);
    h.processes[3]!.becomeReady();
    await eventually(async () => {
      expect((await Effect.runPromise(server.snapshot)).status).toBe("ready");
    });

    await h.dispose();
  });

  it("kills the current process when its scope closes", async () => {
    const h = makeHarness();
    await eventually(() => expect(h.processes).toHaveLength(1));
    h.processes[0]!.becomeReady(50_000);
    const server = await h.server;
    await Effect.runPromise(server.connection);

    await h.dispose();

    expect(h.processes[0]!.killed).toBe(true);
  });
});

describe("restartBackoff", () => {
  it("doubles and caps", () => {
    expect([1, 2, 3, 4, 5, 6].map((n) => restartBackoff(n, 500, 10_000))).toEqual([
      500, 1000, 2000, 4000, 8000, 10_000,
    ]);
  });
});
