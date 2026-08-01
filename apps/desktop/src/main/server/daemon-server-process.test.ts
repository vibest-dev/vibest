import assert from "node:assert/strict";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { readRecord, stopDaemon } from "@vibest/server/daemon";
import { Effect, FileSystem } from "effect";

import { makeDaemonServerProcess } from "./daemon-server-process";
import type { ServerProcessConfig } from "./local-server";

// A minimal daemon body: binds VIBEST_PORT and answers /api/health, which is
// all the launcher's readiness and the spawner's liveness poll observe.
const FAKE_SERVER = `
import http from "node:http";
const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/api/health") return res.end("ok");
  res.statusCode = 404;
  res.end();
});
server.listen(Number(process.env.VIBEST_PORT ?? 0), "127.0.0.1");
`;

// The launcher's file state runs on the platform services; the real ones here,
// exactly as the desktop runtime provides them. `excludeTestServices` because
// readiness and liveness poll on a real clock, which the default TestClock
// never advances.
layer(NodeServices.layer, { excludeTestServices: true, timeout: "30 seconds" })(
  "DaemonServerProcess",
  (it) => {
    /**
     * A temp `$VIBEST_HOME` holding the fake server's entry point. Finalizers
     * run LIFO, so the daemon is stopped before the directory holding its
     * record goes away — on the failure path too.
     */
    const workspace = Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "vibest-daemon-desktop-" });
      const daemonDir = path.join(home, "isolated-daemon");
      const entry = path.join(home, "fake-server.mjs");
      yield* fs.writeFileString(entry, FAKE_SERVER);
      yield* Effect.addFinalizer(() => Effect.ignore(stopDaemon(daemonDir)));
      const config: ServerProcessConfig = {
        entry,
        environment: { ...process.env, VIBEST_HOME: home, VIBEST_DAEMON_DIR: daemonDir },
      };
      return { daemonDir, config };
    });

    it.effect("spawns the shared daemon and reports its endpoint, then attaches on respawn", () =>
      Effect.gen(function* () {
        const { daemonDir, config } = yield* workspace;

        const endpoint = yield* Effect.scoped(
          Effect.gen(function* () {
            const spawn = yield* makeDaemonServerProcess({ pollIntervalMs: 100 });
            const running = yield* spawn(config, 0);
            return yield* running.ready;
          }),
        );

        const record = yield* readRecord(daemonDir);
        assert.ok(record);
        // The endpoint carries the daemon's own minted token, read from the record.
        assert.deepEqual(endpoint, {
          port: Number(new URL(record.address).port),
          token: record.token,
        });

        const again = yield* Effect.scoped(
          Effect.gen(function* () {
            const spawn = yield* makeDaemonServerProcess({ pollIntervalMs: 100 });
            const running = yield* spawn(config, endpoint.port);
            return yield* running.ready;
          }),
        );
        assert.deepEqual(again, endpoint);
        assert.equal((yield* readRecord(daemonDir))?.pid, record.pid);
      }),
    );

    it.effect("resolves awaitExit when the daemon dies", () =>
      Effect.gen(function* () {
        const { daemonDir, config } = yield* workspace;

        const exit = yield* Effect.scoped(
          Effect.gen(function* () {
            const spawn = yield* makeDaemonServerProcess({ pollIntervalMs: 50 });
            const running = yield* spawn(config, 0);
            yield* running.ready;
            yield* stopDaemon(daemonDir);
            return yield* running.awaitExit;
          }),
        );

        assert.deepEqual(exit, { exitCode: null });
      }),
    );
  },
);
