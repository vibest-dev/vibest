import assert from "node:assert/strict";
import childProcess from "node:child_process";
import path from "node:path";
import url from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { Effect, FileSystem } from "effect";

import { DaemonStoppedError } from "../../src/daemon/errors";
import {
  type ResolveDaemonOptions,
  resolveOrSpawnDaemon,
  statusDaemon,
  stopDaemon,
} from "../../src/daemon/launcher";
import { pidAlive } from "../../src/daemon/liveness";
import { readRecord, recordPath, writeRecord } from "../../src/daemon/record";

const FAKE_SERVER = url.fileURLToPath(new URL("./fixtures/fake-server.mjs", import.meta.url));

// The daemon = this argv spawned detached. Point it at the fake server so the
// launcher's attach-or-spawn/health/record orchestration is exercised without
// booting the real runtime.
const serverArgv = [process.execPath, FAKE_SERVER];

const resolve = (options: Omit<ResolveDaemonOptions, "serverArgv">) =>
  resolveOrSpawnDaemon({ serverArgv, ...options });

// `excludeTestServices` because the launcher polls a real daemon's health on a
// real clock: under the default TestClock its retry schedule never advances.
// The timeout covers a spawn + readiness handshake, not a unit assertion.
layer(NodeServices.layer, { excludeTestServices: true, timeout: "30 seconds" })(
  "resolveOrSpawnDaemon",
  (it) => {
    /**
     * A temp `$VIBEST_HOME` bound to the test's scope. Finalizers run LIFO, so
     * the daemon is stopped before the directory holding its record goes away —
     * and both happen however the test ends, which is what the old
     * `afterEach` could only do on the happy path.
     */
    const tempHome = Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "vibest-daemon-" });
      yield* Effect.addFinalizer(() => Effect.ignore(stopDaemon(home)));
      return home;
    });

    it.effect("spawns a daemon, records it, then attaches on the next call", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* tempHome;
        const spawned = yield* resolve({ home, port: 0, readyTimeoutMs: 15_000 });
        assert.equal(spawned.reused, false);
        assert.match(spawned.address, /^http:\/\/127\.0\.0\.1:\d+$/);
        assert.ok(pidAlive(spawned.pid));
        assert.ok(yield* fs.exists(path.join(home, "daemon", "daemon.log")));

        const record = yield* readRecord(home);
        assert.equal(record?.pid, spawned.pid);
        assert.equal(record?.address, spawned.address);
        assert.equal(record?.token, spawned.token);

        const attached = yield* resolve({ home, port: 0 });
        assert.equal(attached.reused, true);
        assert.equal(attached.pid, spawned.pid);
        assert.equal(attached.address, spawned.address);
      }),
    );

    it.effect("isolates lifecycle state in an explicit daemon directory", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* tempHome;
        const daemonDir = path.join(home, "isolated-daemon");
        yield* Effect.addFinalizer(() => Effect.ignore(stopDaemon(home, daemonDir)));

        const spawned = yield* resolve({
          home,
          daemonDir,
          port: 0,
          readyTimeoutMs: 15_000,
        });
        assert.equal((yield* readRecord(home, daemonDir))?.pid, spawned.pid);
        assert.equal(yield* readRecord(home), undefined);
        assert.ok(yield* fs.exists(path.join(daemonDir, "daemon.log")));
        assert.equal(yield* fs.exists(path.join(home, "daemon.pid")), false);
      }),
    );

    it.effect("reports status and stops the daemon", () =>
      Effect.gen(function* () {
        const home = yield* tempHome;
        const spawned = yield* resolve({ home, port: 0, readyTimeoutMs: 15_000 });

        const running = yield* statusDaemon(home);
        assert.equal(running.running, true);
        assert.equal(running.record?.pid, spawned.pid);

        assert.equal(yield* stopDaemon(home), "stopped");
        assert.equal(pidAlive(spawned.pid), false);
        assert.equal(yield* readRecord(home), undefined);
        assert.equal((yield* statusDaemon(home)).running, false);
      }),
    );

    it.effect("respawns when the recorded daemon is dead", () =>
      Effect.gen(function* () {
        const home = yield* tempHome;
        const first = yield* resolve({ home, port: 0, readyTimeoutMs: 15_000 });
        yield* stopDaemon(home);
        assert.equal(pidAlive(first.pid), false);

        const second = yield* resolve({ home, port: 0, readyTimeoutMs: 15_000 });
        assert.equal(second.reused, false);
        assert.notEqual(second.pid, first.pid);
        assert.ok(pidAlive(second.pid));
      }),
    );

    it.effect("reports not-running when stopping with no daemon", () =>
      Effect.gen(function* () {
        const home = yield* tempHome;
        assert.equal(yield* stopDaemon(home), "not-running");
      }),
    );

    it.effect("respawns after a crash that left the record behind", () =>
      Effect.gen(function* () {
        const home = yield* tempHome;
        const first = yield* resolve({ home, port: 0, readyTimeoutMs: 15_000 });

        // Simulate a crash: kill the process without stopDaemon, so the stale
        // record (pid dead) stays and must be replaced, not attached to.
        process.kill(first.pid, "SIGKILL");
        yield* Effect.sleep("20 millis").pipe(Effect.repeat({ while: () => pidAlive(first.pid) }));

        const second = yield* resolve({ home, port: 0, readyTimeoutMs: 15_000 });
        assert.equal(second.reused, false);
        assert.notEqual(second.pid, first.pid);
        assert.ok(pidAlive(second.pid));
      }),
    );

    it.effect("kills a wedged daemon (pid alive, health failing) before respawning", () =>
      Effect.gen(function* () {
        const home = yield* tempHome;
        // A live process that is not a server: pid answers signals, health fails.
        // Deliberately not `ChildProcessSpawner` — the launcher killing it is the
        // assertion, so it must not be tied to the test's scope.
        const wedged = childProcess.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
        const wedgedPid = wedged.pid!;
        yield* writeRecord(home, {
          pid: wedgedPid,
          address: "http://127.0.0.1:1",
          token: "stale",
          startedAt: 0,
        });

        const handle = yield* resolve({ home, port: 0, readyTimeoutMs: 15_000 });
        assert.equal(handle.reused, false);
        assert.equal(pidAlive(wedgedPid), false);
        assert.notEqual(handle.pid, wedgedPid);
      }),
    );

    it.effect("stops every process recorded during a mixed-version conflict", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* tempHome;
        const a = childProcess.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
        const b = childProcess.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
        const pidA = a.pid!;
        const pidB = b.pid!;
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            for (const pid of [pidA, pidB]) {
              if (pidAlive(pid)) process.kill(pid, "SIGKILL");
            }
          }),
        );
        yield* fs.makeDirectory(path.dirname(recordPath(home)), { recursive: true });
        yield* fs.writeFileString(
          recordPath(home),
          JSON.stringify({
            pid: pidA,
            address: "http://127.0.0.1:1",
            token: "nested",
            startedAt: 1,
          }),
          { mode: 0o600 },
        );
        yield* fs.writeFileString(
          path.join(home, "daemon.pid"),
          JSON.stringify({
            pid: pidB,
            address: "http://127.0.0.1:2",
            token: "legacy",
            startedAt: 2,
          }),
          { mode: 0o600 },
        );

        assert.equal(yield* stopDaemon(home), "stopped");
        assert.equal(pidAlive(pidA), false);
        assert.equal(pidAlive(pidB), false);
      }),
    );

    it.effect("refuses to auto-respawn a daemon the user explicitly stopped", () =>
      Effect.gen(function* () {
        const home = yield* tempHome;
        const fs = yield* FileSystem.FileSystem;
        yield* resolve({ home, port: 0, readyTimeoutMs: 15_000 });
        yield* stopDaemon(home);
        assert.ok(yield* fs.exists(path.join(home, "daemon", "daemon.stopped")));
        assert.ok(yield* fs.exists(path.join(home, "daemon.stopped")));

        const error = yield* Effect.flip(resolve({ home, port: 0, autoRespawn: true }));
        assert.ok(error instanceof DaemonStoppedError);

        // An explicit start clears the tombstone; auto-respawn works again after.
        const restarted = yield* resolve({ home, port: 0, readyTimeoutMs: 15_000 });
        assert.equal(restarted.reused, false);
        const attached = yield* resolve({ home, port: 0, autoRespawn: true });
        assert.equal(attached.pid, restarted.pid);
      }),
    );

    it.effect("honors and clears a legacy root-level tombstone", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* tempHome;
        const legacyTombstone = path.join(home, "daemon.stopped");
        yield* fs.writeFileString(legacyTombstone, "0", { mode: 0o600 });

        const error = yield* Effect.flip(resolve({ home, port: 0, autoRespawn: true }));
        assert.ok(error instanceof DaemonStoppedError);

        yield* resolve({ home, port: 0, readyTimeoutMs: 15_000 });
        assert.equal(yield* fs.exists(legacyTombstone), false);
      }),
    );

    it.effect("serializes concurrent launchers onto a single daemon", () =>
      Effect.gen(function* () {
        const home = yield* tempHome;
        const [a, b] = yield* Effect.all(
          [
            resolve({ home, port: 0, readyTimeoutMs: 15_000 }),
            resolve({ home, port: 0, readyTimeoutMs: 15_000 }),
          ],
          { concurrency: 2 },
        );
        assert.equal(a.pid, b.pid);
        assert.equal(a.address, b.address);
        assert.equal([a.reused, b.reused].filter((reused) => !reused).length, 1);
      }),
    );
  },
);
