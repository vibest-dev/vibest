import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DaemonStoppedError,
  resolveOrSpawnDaemon,
  statusDaemon,
  stopDaemon,
} from "../../src/daemon/launcher";
import { pidAlive } from "../../src/daemon/liveness";
import { readRecord, writeRecord } from "../../src/daemon/record";

const FAKE_SERVER = url.fileURLToPath(new URL("./fixtures/fake-server.mjs", import.meta.url));

// The daemon = this argv spawned detached. Point it at the fake server so the
// launcher's attach-or-spawn/health/record orchestration is exercised without
// booting the real runtime.
const serverArgv = [process.execPath, FAKE_SERVER];

describe("resolveOrSpawnDaemon", () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-daemon-"));
  });
  afterEach(async () => {
    await stopDaemon(home);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("spawns a daemon, records it, then attaches on the next call", async () => {
    const spawned = await resolveOrSpawnDaemon({
      home,
      serverArgv,
      port: 0,
      readyTimeoutMs: 15_000,
    });
    expect(spawned.reused).toBe(false);
    expect(spawned.address).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(pidAlive(spawned.pid)).toBe(true);

    const record = readRecord(home);
    expect(record?.pid).toBe(spawned.pid);
    expect(record?.address).toBe(spawned.address);
    expect(record?.token).toBe(spawned.token);

    const attached = await resolveOrSpawnDaemon({ home, serverArgv, port: 0 });
    expect(attached.reused).toBe(true);
    expect(attached.pid).toBe(spawned.pid);
    expect(attached.address).toBe(spawned.address);
  });

  it("reports status and stops the daemon", async () => {
    const spawned = await resolveOrSpawnDaemon({
      home,
      serverArgv,
      port: 0,
      readyTimeoutMs: 15_000,
    });

    const running = await statusDaemon(home);
    expect(running.running).toBe(true);
    expect(running.record?.pid).toBe(spawned.pid);

    expect(await stopDaemon(home)).toBe("stopped");
    expect(pidAlive(spawned.pid)).toBe(false);
    expect(readRecord(home)).toBeUndefined();
    expect((await statusDaemon(home)).running).toBe(false);
  });

  it("respawns when the recorded daemon is dead", async () => {
    const first = await resolveOrSpawnDaemon({ home, serverArgv, port: 0, readyTimeoutMs: 15_000 });
    await stopDaemon(home);
    expect(pidAlive(first.pid)).toBe(false);

    const second = await resolveOrSpawnDaemon({
      home,
      serverArgv,
      port: 0,
      readyTimeoutMs: 15_000,
    });
    expect(second.reused).toBe(false);
    expect(second.pid).not.toBe(first.pid);
    expect(pidAlive(second.pid)).toBe(true);
  });

  it("reports not-running when stopping with no daemon", async () => {
    expect(await stopDaemon(home)).toBe("not-running");
  });

  it("attaches when the requested origins are already covered", async () => {
    const first = await resolveOrSpawnDaemon({
      home,
      serverArgv,
      port: 0,
      corsOrigins: ["vibest://app", "http://localhost:5173"],
      readyTimeoutMs: 15_000,
    });

    const attached = await resolveOrSpawnDaemon({
      home,
      serverArgv,
      port: 0,
      corsOrigins: ["vibest://app"],
    });
    expect(attached.reused).toBe(true);
    expect(attached.pid).toBe(first.pid);
  });

  it("restarts the daemon with the origin union when a new origin joins", async () => {
    const first = await resolveOrSpawnDaemon({
      home,
      serverArgv,
      port: 0,
      readyTimeoutMs: 15_000,
    });

    const second = await resolveOrSpawnDaemon({
      home,
      serverArgv,
      port: 0,
      corsOrigins: ["vibest://app"],
      readyTimeoutMs: 15_000,
    });
    expect(second.reused).toBe(false);
    expect(second.pid).not.toBe(first.pid);
    expect(pidAlive(first.pid)).toBe(false);
    expect(readRecord(home)?.corsOrigins).toEqual(["vibest://app"]);
  });

  it("preserves the recorded origins across a crash respawn", async () => {
    const first = await resolveOrSpawnDaemon({
      home,
      serverArgv,
      port: 0,
      corsOrigins: ["vibest://app"],
      readyTimeoutMs: 15_000,
    });

    // Simulate a crash: kill the process without stopDaemon, record stays.
    process.kill(first.pid, "SIGKILL");
    while (pidAlive(first.pid)) await new Promise((resolve) => setTimeout(resolve, 20));

    const second = await resolveOrSpawnDaemon({
      home,
      serverArgv,
      port: 0,
      corsOrigins: ["http://localhost:5173"],
      readyTimeoutMs: 15_000,
    });
    expect(second.reused).toBe(false);
    expect(readRecord(home)?.corsOrigins).toEqual(["vibest://app", "http://localhost:5173"]);
  });

  it("kills a wedged daemon (pid alive, health failing) before respawning", async () => {
    // A live process that is not a server: pid answers signals, health fails.
    const wedged = childProcess.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
    const wedgedPid = wedged.pid!;
    writeRecord(home, {
      pid: wedgedPid,
      address: "http://127.0.0.1:1",
      token: "stale",
      corsOrigins: [],
      startedAt: 0,
    });

    const handle = await resolveOrSpawnDaemon({
      home,
      serverArgv,
      port: 0,
      readyTimeoutMs: 15_000,
    });
    expect(handle.reused).toBe(false);
    expect(pidAlive(wedgedPid)).toBe(false);
    expect(handle.pid).not.toBe(wedgedPid);
  });

  it("refuses to auto-respawn a daemon the user explicitly stopped", async () => {
    await resolveOrSpawnDaemon({ home, serverArgv, port: 0, readyTimeoutMs: 15_000 });
    await stopDaemon(home);

    await expect(
      resolveOrSpawnDaemon({ home, serverArgv, port: 0, autoRespawn: true }),
    ).rejects.toBeInstanceOf(DaemonStoppedError);

    // An explicit start clears the tombstone; auto-respawn works again after.
    const restarted = await resolveOrSpawnDaemon({
      home,
      serverArgv,
      port: 0,
      readyTimeoutMs: 15_000,
    });
    expect(restarted.reused).toBe(false);
    const attached = await resolveOrSpawnDaemon({ home, serverArgv, port: 0, autoRespawn: true });
    expect(attached.pid).toBe(restarted.pid);
  });

  it("serializes concurrent launchers onto a single daemon", async () => {
    const [a, b] = await Promise.all([
      resolveOrSpawnDaemon({ home, serverArgv, port: 0, readyTimeoutMs: 15_000 }),
      resolveOrSpawnDaemon({ home, serverArgv, port: 0, readyTimeoutMs: 15_000 }),
    ]);
    expect(a.pid).toBe(b.pid);
    expect(a.address).toBe(b.address);
    expect([a.reused, b.reused].filter((reused) => !reused)).toHaveLength(1);
  });
});
