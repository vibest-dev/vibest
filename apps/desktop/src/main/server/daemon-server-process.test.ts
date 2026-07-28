import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { readRecord, stopDaemon } from "@vibest/server/daemon";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
// exactly as the desktop runtime provides them.
const run = <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)));

describe("DaemonServerProcess", () => {
  let home: string;
  let entry: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-daemon-desktop-"));
    entry = path.join(home, "fake-server.mjs");
    fs.writeFileSync(entry, FAKE_SERVER);
  });
  afterEach(async () => {
    await run(stopDaemon(home));
    fs.rmSync(home, { recursive: true, force: true });
  });

  const config = (): ServerProcessConfig => ({
    entry,
    environment: { ...process.env, VIBEST_HOME: home },
  });

  it("spawns the shared daemon and reports its endpoint, then attaches on respawn", async () => {
    const endpoint = await run(
      Effect.scoped(
        Effect.gen(function* () {
          const spawn = yield* makeDaemonServerProcess({ pollIntervalMs: 100 });
          const running = yield* spawn(config(), 0);
          return yield* running.ready;
        }),
      ),
    );

    const record = await run(readRecord(home));
    expect(record).toBeDefined();
    // The endpoint carries the daemon's own minted token, read from the record.
    expect(endpoint).toEqual({
      port: Number(new URL(record!.address).port),
      token: record!.token,
    });

    const again = await run(
      Effect.scoped(
        Effect.gen(function* () {
          const spawn = yield* makeDaemonServerProcess({ pollIntervalMs: 100 });
          const running = yield* spawn(config(), endpoint.port);
          return yield* running.ready;
        }),
      ),
    );
    expect(again).toEqual(endpoint);
    expect((await run(readRecord(home)))?.pid).toBe(record!.pid);
  });

  it("resolves awaitExit when the daemon dies", async () => {
    const exit = await run(
      Effect.scoped(
        Effect.gen(function* () {
          const spawn = yield* makeDaemonServerProcess({ pollIntervalMs: 50 });
          const running = yield* spawn(config(), 0);
          yield* running.ready;
          yield* stopDaemon(home);
          return yield* running.awaitExit;
        }),
      ),
    );

    expect(exit).toEqual({ exitCode: null });
  });
});
