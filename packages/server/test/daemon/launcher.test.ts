import assert from "node:assert/strict";
import childProcess from "node:child_process";
import path from "node:path";
import url from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { Effect, Fiber, FileSystem } from "effect";

import { resolveDaemonLocation } from "../../src/config/paths";
import { DaemonLaunchError, DaemonStopError, DaemonStoppedError } from "../../src/daemon/errors";
import {
  type ResolveDaemonOptions,
  resolveOrSpawnDaemon,
  statusDaemon,
  stopDaemon,
} from "../../src/daemon/launcher";
import { pidAlive } from "../../src/daemon/liveness";
import { lockExists, releaseLock, tryAcquireLock } from "../../src/daemon/lock";
import { readRecord, writeRecord } from "../../src/daemon/record";
import { clearTombstone, hasTombstone, writeTombstone } from "../../src/daemon/tombstone";

const FAKE_SERVER = url.fileURLToPath(new URL("./fixtures/fake-server.mjs", import.meta.url));

// The daemon = this argv spawned detached. Point it at the fake server so the
// launcher's attach-or-spawn/health/record orchestration is exercised without
// booting the real runtime.
const serverArgv = [process.execPath, FAKE_SERVER];

const resolve = (
  options: Omit<ResolveDaemonOptions, "launchOwnerPath" | "serverArgv"> & {
    readonly launchOwnerPath?: string;
  },
) => {
  const { launchOwnerPath = FAKE_SERVER, ...rest } = options;
  return resolveOrSpawnDaemon({ serverArgv, launchOwnerPath, ...rest });
};

// `excludeTestServices` because the launcher polls a real daemon's health on a
// real clock: under the default TestClock its retry schedule never advances.
// The timeout covers a spawn + readiness handshake, not a unit assertion.
layer(NodeServices.layer, { excludeTestServices: true, timeout: "30 seconds" })(
  "resolveOrSpawnDaemon",
  (it) => {
    /**
     * A temp `$VIBEST_HOME` and the pair a front door would resolve for it —
     * through the real resolver, so these tests never restate where the default
     * daemon directory is (`test/paths.test.ts` owns that). Bound to the test's
     * scope, and finalizers run LIFO, so the daemon is stopped before the
     * directory holding its record goes away — however the test ends, which is
     * what the old `afterEach` could only do on the happy path.
     */
    const tempHome = Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "vibest-daemon-" });
      const location = resolveDaemonLocation({ VIBEST_HOME: home });
      yield* Effect.addFinalizer(() =>
        Effect.ignore(stopDaemon(location.daemonDir, location.legacyDaemonDir)),
      );
      return location;
    });

    it.effect("spawns a daemon, records it, then attaches on the next call", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { home, daemonDir } = yield* tempHome;
        const spawned = yield* resolve({ home, daemonDir, port: 0, readyTimeoutMs: 15_000 });
        assert.equal(spawned.reused, false);
        assert.match(spawned.address, /^http:\/\/127\.0\.0\.1:\d+$/);
        assert.ok(pidAlive(spawned.pid));
        // Stdio lands with the rest of the logging, not in the daemon
        // directory — that holds lifecycle state only.
        assert.ok(yield* fs.exists(path.join(home, "logs", "daemon-stdio.log")));
        assert.equal(yield* fs.exists(path.join(daemonDir, "daemon.log")), false);
        // Asserted *here*, on a real launch, and not only where the batched
        // sink is unit-tested: the launcher creates `logs/` before the daemon
        // it is spawning exists, so it is the one whose mode decides on a fresh
        // install. Testing the sink alone passes while the daemon path leaves
        // the directory world-readable.
        const logs = yield* fs.stat(path.join(home, "logs"));
        const stdio = yield* fs.stat(path.join(home, "logs", "daemon-stdio.log"));
        assert.equal((Number(logs.mode) & 0o777).toString(8), "700");
        assert.equal((Number(stdio.mode) & 0o777).toString(8), "600");

        const record = yield* readRecord(daemonDir);
        assert.equal(record?.pid, spawned.pid);
        assert.equal(record?.address, spawned.address);
        assert.equal(record?.token, spawned.token);
        assert.equal(record?.launchOwnerPath, FAKE_SERVER);

        const attached = yield* resolve({ home, daemonDir, port: 0 });
        assert.equal(attached.reused, true);
        assert.equal(attached.pid, spawned.pid);
        assert.equal(attached.address, spawned.address);
      }),
    );

    it.effect("adopts a healthy root-layout daemon into the default nested layout", () =>
      Effect.gen(function* () {
        const { home, daemonDir } = yield* tempHome;
        const legacyDaemonDir = home;
        const legacy = yield* resolve({
          home,
          daemonDir: legacyDaemonDir,
          port: 0,
          readyTimeoutMs: 15_000,
        });

        const adopted = yield* resolve({
          home,
          daemonDir,
          legacyDaemonDir,
          port: 0,
          readyTimeoutMs: 15_000,
        });
        assert.equal(adopted.reused, true);
        assert.equal(adopted.pid, legacy.pid);
        assert.deepEqual(yield* readRecord(daemonDir), yield* readRecord(legacyDaemonDir));
      }),
    );

    it.effect("replaces a healthy legacy daemon recorded without a launch owner", () =>
      Effect.gen(function* () {
        const { home, daemonDir } = yield* tempHome;
        const legacyDaemonDir = home;
        const legacy = yield* resolve({
          home,
          daemonDir: legacyDaemonDir,
          port: 0,
          readyTimeoutMs: 15_000,
        });
        const record = yield* readRecord(legacyDaemonDir);
        assert.ok(record);
        yield* writeRecord(legacyDaemonDir, {
          pid: record.pid,
          address: record.address,
          token: record.token,
          startedAt: record.startedAt,
        });

        const replacement = yield* resolve({
          home,
          daemonDir,
          legacyDaemonDir,
          port: 0,
          readyTimeoutMs: 15_000,
        });
        assert.equal(replacement.reused, false);
        assert.notEqual(replacement.pid, legacy.pid);
        assert.equal(pidAlive(legacy.pid), false);
        assert.deepEqual(yield* readRecord(daemonDir), yield* readRecord(legacyDaemonDir));
      }),
    );

    it.effect("serializes concurrent migration of a stale legacy daemon", () =>
      Effect.gen(function* () {
        const { home, daemonDir } = yield* tempHome;
        const legacyDaemonDir = home;
        const legacy = yield* resolve({
          home,
          daemonDir: legacyDaemonDir,
          port: 0,
          readyTimeoutMs: 15_000,
        });
        const record = yield* readRecord(legacyDaemonDir);
        assert.ok(record);
        yield* writeRecord(legacyDaemonDir, {
          pid: record.pid,
          address: record.address,
          token: record.token,
          startedAt: record.startedAt,
        });

        const [a, b] = yield* Effect.all(
          [
            resolve({
              home,
              daemonDir,
              legacyDaemonDir,
              port: 0,
              readyTimeoutMs: 15_000,
            }),
            resolve({
              home,
              daemonDir,
              legacyDaemonDir,
              port: 0,
              readyTimeoutMs: 15_000,
            }),
          ],
          { concurrency: 2 },
        );
        assert.equal(a.pid, b.pid);
        assert.equal([a.reused, b.reused].filter((reused) => !reused).length, 1);
        assert.equal(pidAlive(legacy.pid), false);
      }),
    );

    it.effect("waits for a root-only launcher lock before migrating", () =>
      Effect.gen(function* () {
        const { home, daemonDir } = yield* tempHome;
        const legacyDaemonDir = home;
        assert.equal(yield* tryAcquireLock(legacyDaemonDir), true);
        yield* Effect.addFinalizer(() => releaseLock(legacyDaemonDir));

        const fiber = yield* Effect.forkScoped(
          resolve({
            home,
            daemonDir,
            legacyDaemonDir,
            port: 0,
            readyTimeoutMs: 15_000,
          }),
        );
        yield* Effect.sleep("100 millis");
        assert.equal(yield* readRecord(daemonDir), undefined);

        yield* releaseLock(legacyDaemonDir);
        const handle = yield* Fiber.join(fiber);
        assert.ok(pidAlive(handle.pid));
      }),
    );

    it.effect("waits for a nested-only launcher lock before migrating", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { home, daemonDir } = yield* tempHome;
        const legacyDaemonDir = home;
        yield* fs.makeDirectory(daemonDir, { recursive: true });
        assert.equal(yield* tryAcquireLock(daemonDir), true);
        yield* Effect.addFinalizer(() => releaseLock(daemonDir));

        const fiber = yield* Effect.forkScoped(
          resolve({
            home,
            daemonDir,
            legacyDaemonDir,
            port: 0,
            readyTimeoutMs: 15_000,
          }),
        );
        yield* Effect.sleep("100 millis");
        assert.equal(yield* readRecord(daemonDir), undefined);

        yield* releaseLock(daemonDir);
        const handle = yield* Fiber.join(fiber);
        assert.ok(pidAlive(handle.pid));
      }),
    );

    it.effect("waits for an in-flight launch before stopping its published daemon", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { home, daemonDir } = yield* tempHome;
        const legacyDaemonDir = home;
        yield* fs.makeDirectory(daemonDir, { recursive: true });
        assert.equal(yield* tryAcquireLock(legacyDaemonDir), true);
        assert.equal(yield* tryAcquireLock(daemonDir), true);
        yield* Effect.addFinalizer(() =>
          Effect.all([releaseLock(legacyDaemonDir), releaseLock(daemonDir)], { discard: true }),
        );

        const child = childProcess.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
        const pid = child.pid!;
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (pidAlive(pid)) child.kill("SIGKILL");
          }),
        );

        const stopFiber = yield* Effect.forkScoped(stopDaemon(daemonDir, legacyDaemonDir));
        yield* Effect.sleep("100 millis");
        assert.equal(yield* hasTombstone(legacyDaemonDir), true);
        assert.equal(yield* hasTombstone(daemonDir), true);
        // Simulate a compatible explicit launcher clearing the early stop
        // signal while it still owns the locks and is about to publish.
        yield* clearTombstone(legacyDaemonDir);
        yield* clearTombstone(daemonDir);

        const record = {
          pid,
          address: "http://127.0.0.1:1",
          token: "in-flight",
          startedAt: 0,
          launchOwnerPath: FAKE_SERVER,
        };
        yield* writeRecord(legacyDaemonDir, record);
        yield* writeRecord(daemonDir, record);
        yield* releaseLock(daemonDir);
        yield* releaseLock(legacyDaemonDir);

        assert.equal(yield* Fiber.join(stopFiber), "stopped");
        assert.equal(pidAlive(pid), false);
        assert.equal(yield* readRecord(legacyDaemonDir), undefined);
        assert.equal(yield* readRecord(daemonDir), undefined);
        assert.equal(yield* hasTombstone(legacyDaemonDir), true);
        assert.equal(yield* hasTombstone(daemonDir), true);
      }),
    );

    it.effect("preserves a legacy stop tombstone during automatic respawn", () =>
      Effect.gen(function* () {
        const { home, daemonDir } = yield* tempHome;
        const legacyDaemonDir = home;
        yield* writeTombstone(legacyDaemonDir);

        const error = yield* Effect.flip(
          resolve({ home, daemonDir, legacyDaemonDir, port: 0, autoRespawn: true }),
        );
        assert.ok(error instanceof DaemonStoppedError);
        assert.equal(yield* hasTombstone(legacyDaemonDir), true);
        assert.equal(yield* readRecord(daemonDir), undefined);

        const started = yield* resolve({
          home,
          daemonDir,
          legacyDaemonDir,
          port: 0,
          readyTimeoutMs: 15_000,
        });
        assert.equal(started.reused, false);
        assert.equal(yield* hasTombstone(legacyDaemonDir), false);
        assert.equal(yield* hasTombstone(daemonDir), false);
      }),
    );

    it.effect("status and stop include a legacy root-layout daemon", () =>
      Effect.gen(function* () {
        const { home, daemonDir } = yield* tempHome;
        const legacyDaemonDir = home;
        const legacy = yield* resolve({
          home,
          daemonDir: legacyDaemonDir,
          port: 0,
          readyTimeoutMs: 15_000,
        });

        const status = yield* statusDaemon(daemonDir, legacyDaemonDir);
        assert.equal(status.running, true);
        assert.equal(status.record?.pid, legacy.pid);
        assert.equal(yield* stopDaemon(daemonDir, legacyDaemonDir), "stopped");
        assert.equal(pidAlive(legacy.pid), false);
      }),
    );

    it.effect("replaces a healthy daemon whose launch owner disappeared", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { home, daemonDir } = yield* tempHome;
        const firstOwner = path.join(home, "first-owner");
        const replacementOwner = path.join(home, "replacement-owner");
        yield* fs.writeFileString(firstOwner, "owner");

        const first = yield* resolve({
          home,
          daemonDir,
          port: 0,
          readyTimeoutMs: 15_000,
          launchOwnerPath: firstOwner,
        });
        yield* fs.remove(firstOwner);
        yield* fs.writeFileString(replacementOwner, "owner");

        const replacement = yield* resolve({
          home,
          daemonDir,
          port: 0,
          readyTimeoutMs: 15_000,
          launchOwnerPath: replacementOwner,
        });
        assert.equal(replacement.reused, false);
        assert.notEqual(replacement.pid, first.pid);
        assert.equal(pidAlive(first.pid), false);
      }),
    );

    it.effect("serializes concurrent replacements of a stale launch owner", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { home, daemonDir } = yield* tempHome;
        const firstOwner = path.join(home, "first-owner");
        const replacementOwner = path.join(home, "replacement-owner");
        yield* fs.writeFileString(firstOwner, "owner");
        yield* fs.writeFileString(replacementOwner, "owner");
        const first = yield* resolve({
          home,
          daemonDir,
          port: 0,
          readyTimeoutMs: 15_000,
          launchOwnerPath: firstOwner,
        });
        yield* fs.remove(firstOwner);

        const [a, b] = yield* Effect.all(
          [
            resolve({
              home,
              daemonDir,
              port: 0,
              readyTimeoutMs: 15_000,
              launchOwnerPath: replacementOwner,
            }),
            resolve({
              home,
              daemonDir,
              port: 0,
              readyTimeoutMs: 15_000,
              launchOwnerPath: replacementOwner,
            }),
          ],
          { concurrency: 2 },
        );
        assert.equal(a.pid, b.pid);
        assert.equal([a.reused, b.reused].filter((reused) => !reused).length, 1);
        assert.equal(pidAlive(first.pid), false);
      }),
    );

    it.effect("reuses a healthy daemon when a different caller owner also exists", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { home, daemonDir } = yield* tempHome;
        const otherOwner = path.join(home, "other-owner");
        yield* fs.writeFileString(otherOwner, "owner");
        const first = yield* resolve({ home, daemonDir, port: 0, readyTimeoutMs: 15_000 });

        const attached = yield* resolve({
          home,
          daemonDir,
          port: 0,
          launchOwnerPath: otherOwner,
        });
        assert.equal(attached.reused, true);
        assert.equal(attached.pid, first.pid);
      }),
    );

    it.effect("replaces a healthy daemon recorded without a launch owner", () =>
      Effect.gen(function* () {
        const { home, daemonDir } = yield* tempHome;
        const first = yield* resolve({ home, daemonDir, port: 0, readyTimeoutMs: 15_000 });
        const record = yield* readRecord(daemonDir);
        assert.ok(record);
        yield* writeRecord(daemonDir, {
          pid: record.pid,
          address: record.address,
          token: record.token,
          startedAt: record.startedAt,
        });

        const replacement = yield* resolve({
          home,
          daemonDir,
          port: 0,
          readyTimeoutMs: 15_000,
        });
        assert.equal(replacement.reused, false);
        assert.notEqual(replacement.pid, first.pid);
        assert.equal(pidAlive(first.pid), false);
      }),
    );

    it.effect("isolates lifecycle state in an explicit daemon directory", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { home, daemonDir: defaultDir } = yield* tempHome;
        const daemonDir = path.join(home, "isolated-daemon");
        yield* Effect.addFinalizer(() => Effect.ignore(stopDaemon(daemonDir)));

        const spawned = yield* resolve({
          home,
          daemonDir,
          port: 0,
          readyTimeoutMs: 15_000,
        });
        assert.equal((yield* readRecord(daemonDir))?.pid, spawned.pid);
        // Nothing leaks into the default directory, nor into `$VIBEST_HOME`.
        assert.equal(yield* readRecord(defaultDir), undefined);
        for (const file of ["daemon.pid", "daemon.lock", "daemon.stopped"]) {
          assert.equal(yield* fs.exists(path.join(home, file)), false);
          assert.equal(yield* fs.exists(path.join(defaultDir, file)), false);
        }
        // Logging is deliberately NOT isolated per daemon directory: one
        // `$VIBEST_HOME` means one place to read, and every line carries the
        // `pid` that wrote it.
        assert.ok(yield* fs.exists(path.join(home, "logs", "daemon-stdio.log")));

        assert.equal(yield* stopDaemon(daemonDir), "stopped");
        assert.ok(yield* fs.exists(path.join(daemonDir, "daemon.stopped")));
        assert.equal(yield* fs.exists(path.join(home, "daemon.stopped")), false);
      }),
    );

    it.effect("reports status and stops the daemon", () =>
      Effect.gen(function* () {
        const { home, daemonDir } = yield* tempHome;
        const spawned = yield* resolve({ home, daemonDir, port: 0, readyTimeoutMs: 15_000 });

        const running = yield* statusDaemon(daemonDir);
        assert.equal(running.running, true);
        assert.equal(running.record?.pid, spawned.pid);

        assert.equal(yield* stopDaemon(daemonDir), "stopped");
        assert.equal(pidAlive(spawned.pid), false);
        assert.equal(yield* readRecord(daemonDir), undefined);
        assert.equal((yield* statusDaemon(daemonDir)).running, false);
      }),
    );

    it.effect("respawns when the recorded daemon is dead", () =>
      Effect.gen(function* () {
        const { home, daemonDir } = yield* tempHome;
        const first = yield* resolve({ home, daemonDir, port: 0, readyTimeoutMs: 15_000 });
        yield* stopDaemon(daemonDir);
        assert.equal(pidAlive(first.pid), false);

        const second = yield* resolve({ home, daemonDir, port: 0, readyTimeoutMs: 15_000 });
        assert.equal(second.reused, false);
        assert.notEqual(second.pid, first.pid);
        assert.ok(pidAlive(second.pid));
      }),
    );

    it.effect("reports not-running when stopping with no daemon", () =>
      Effect.gen(function* () {
        const { daemonDir } = yield* tempHome;
        assert.equal(yield* stopDaemon(daemonDir), "not-running");
      }),
    );

    it.effect("leaves no tombstone behind when there was nothing to stop", () =>
      Effect.gen(function* () {
        const { home, daemonDir, legacyDaemonDir } = yield* tempHome;
        assert.equal(yield* stopDaemon(daemonDir, legacyDaemonDir), "not-running");
        assert.equal(yield* hasTombstone(daemonDir), false);
        if (legacyDaemonDir !== undefined) {
          assert.equal(yield* hasTombstone(legacyDaemonDir), false);
        }

        // Vetoing auto-heal is the consequence of stopping a *running* daemon.
        // A no-op stop that tombstoned the home would refuse every later
        // respawn until someone ran an explicit start.
        const respawned = yield* resolve({
          home,
          daemonDir,
          legacyDaemonDir,
          port: 0,
          autoRespawn: true,
          readyTimeoutMs: 15_000,
        });
        assert.equal(respawned.reused, false);
      }),
    );

    it.effect("fails instead of hanging when another launcher holds the locks", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { daemonDir, legacyDaemonDir } = yield* tempHome;
        yield* fs.makeDirectory(daemonDir, { recursive: true });
        // Held by this very much alive process, so it is not reclaimable and
        // the wait can only end on its deadline.
        assert.equal(yield* tryAcquireLock(daemonDir), true);
        yield* Effect.addFinalizer(() => releaseLock(daemonDir));

        const error = yield* Effect.flip(stopDaemon(daemonDir, legacyDaemonDir, 300));
        assert.ok(error instanceof DaemonStopError);
        // The stop intent outlives the failure, so retrying is the whole recovery.
        assert.equal(yield* hasTombstone(daemonDir), true);
      }),
    );

    it.effect("keeps a healthy daemon whose launch owner path cannot be read", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { home, daemonDir } = yield* tempHome;
        const vault = path.join(home, "vault");
        yield* fs.makeDirectory(vault, { recursive: true });
        const launchOwnerPath = path.join(vault, "entry.mjs");
        yield* fs.writeFileString(launchOwnerPath, "");
        const running = yield* resolve({
          home,
          daemonDir,
          port: 0,
          launchOwnerPath,
          readyTimeoutMs: 15_000,
        });

        // EACCES on the owner path is "we could not tell", not "the
        // installation is gone" — answering `false` here would SIGKILL a
        // perfectly healthy daemon over a transient permission error.
        yield* fs.chmod(vault, 0o000);
        yield* Effect.addFinalizer(() => Effect.ignore(fs.chmod(vault, 0o700)));

        const attached = yield* resolve({ home, daemonDir, port: 0, launchOwnerPath });
        assert.equal(attached.reused, true);
        assert.equal(attached.pid, running.pid);
      }),
    );

    it.effect("releases every lifecycle lock when a launch fails", () =>
      Effect.gen(function* () {
        const { home, daemonDir, legacyDaemonDir } = yield* tempHome;
        const error = yield* Effect.flip(
          resolveOrSpawnDaemon({
            home,
            daemonDir,
            legacyDaemonDir,
            // A "server" that exits immediately: the readiness wait
            // short-circuits on the dead pid, so this fails fast and leaves no
            // process behind.
            serverArgv: [process.execPath, "-e", "process.exit(1)"],
            launchOwnerPath: FAKE_SERVER,
            port: 0,
            readyTimeoutMs: 2_000,
          }),
        );
        assert.ok(error instanceof DaemonLaunchError);
        assert.equal(yield* lockExists(daemonDir), false);
        if (legacyDaemonDir !== undefined) {
          assert.equal(yield* lockExists(legacyDaemonDir), false);
        }
      }),
    );

    it.effect("respawns after a crash that left the record behind", () =>
      Effect.gen(function* () {
        const { home, daemonDir } = yield* tempHome;
        const first = yield* resolve({ home, daemonDir, port: 0, readyTimeoutMs: 15_000 });

        // Simulate a crash: kill the process without stopDaemon, so the stale
        // record (pid dead) stays and must be replaced, not attached to.
        process.kill(first.pid, "SIGKILL");
        yield* Effect.sleep("20 millis").pipe(Effect.repeat({ while: () => pidAlive(first.pid) }));

        const second = yield* resolve({ home, daemonDir, port: 0, readyTimeoutMs: 15_000 });
        assert.equal(second.reused, false);
        assert.notEqual(second.pid, first.pid);
        assert.ok(pidAlive(second.pid));
      }),
    );

    it.effect("kills the daemon and removes its record when it never becomes healthy", () =>
      Effect.gen(function* () {
        const { home, daemonDir, legacyDaemonDir } = yield* tempHome;
        // A process that stays alive but never answers health. The record is
        // written before the health wait (so a dying launcher cannot orphan an
        // undiscoverable daemon), which makes this cleanup the path that takes
        // it back out.
        const error = yield* Effect.flip(
          resolveOrSpawnDaemon({
            serverArgv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
            launchOwnerPath: process.execPath,
            home,
            daemonDir,
            legacyDaemonDir,
            port: 0,
            readyTimeoutMs: 500,
          }),
        );
        assert.match(error.message, /did not become healthy/);
        assert.equal(yield* readRecord(daemonDir), undefined);
        assert.equal(
          legacyDaemonDir === undefined ? undefined : yield* readRecord(legacyDaemonDir),
          undefined,
        );
      }),
    );

    it.effect("kills a wedged daemon (pid alive, health failing) before respawning", () =>
      Effect.gen(function* () {
        const { home, daemonDir } = yield* tempHome;
        // A live process that is not a server: pid answers signals, health fails.
        // Deliberately not `ChildProcessSpawner` — the launcher killing it is the
        // assertion, so it must not be tied to the test's scope.
        const wedged = childProcess.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
        const wedgedPid = wedged.pid!;
        yield* writeRecord(daemonDir, {
          pid: wedgedPid,
          address: "http://127.0.0.1:1",
          token: "stale",
          startedAt: 0,
        });

        const handle = yield* resolve({ home, daemonDir, port: 0, readyTimeoutMs: 15_000 });
        assert.equal(handle.reused, false);
        assert.equal(pidAlive(wedgedPid), false);
        assert.notEqual(handle.pid, wedgedPid);
      }),
    );

    it.effect("does not clear a stop tombstone while an old daemon is still alive", () =>
      Effect.gen(function* () {
        const { home, daemonDir } = yield* tempHome;
        const running = yield* resolve({ home, daemonDir, port: 0, readyTimeoutMs: 15_000 });
        yield* writeTombstone(daemonDir);

        const error = yield* Effect.flip(resolve({ home, daemonDir, port: 0, autoRespawn: true }));
        assert.ok(error instanceof DaemonStoppedError);
        assert.equal(pidAlive(running.pid), true);
        assert.equal(yield* hasTombstone(daemonDir), true);
      }),
    );

    it.effect("refuses to auto-respawn a daemon the user explicitly stopped", () =>
      Effect.gen(function* () {
        const { home, daemonDir } = yield* tempHome;
        const fs = yield* FileSystem.FileSystem;
        yield* resolve({ home, daemonDir, port: 0, readyTimeoutMs: 15_000 });
        yield* stopDaemon(daemonDir);
        assert.ok(yield* fs.exists(path.join(daemonDir, "daemon.stopped")));

        const error = yield* Effect.flip(resolve({ home, daemonDir, port: 0, autoRespawn: true }));
        assert.ok(error instanceof DaemonStoppedError);

        // An explicit start clears the tombstone; auto-respawn works again after.
        const restarted = yield* resolve({ home, daemonDir, port: 0, readyTimeoutMs: 15_000 });
        assert.equal(restarted.reused, false);
        const attached = yield* resolve({ home, daemonDir, port: 0, autoRespawn: true });
        assert.equal(attached.pid, restarted.pid);
      }),
    );

    it.effect("serializes concurrent launchers onto a single daemon", () =>
      Effect.gen(function* () {
        const { home, daemonDir } = yield* tempHome;
        const [a, b] = yield* Effect.all(
          [
            resolve({ home, daemonDir, port: 0, readyTimeoutMs: 15_000 }),
            resolve({ home, daemonDir, port: 0, readyTimeoutMs: 15_000 }),
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
