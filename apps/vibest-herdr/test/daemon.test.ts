import childProcess from "node:child_process"
import net from "node:net"

// vibestd's start lock (flock on vibestd.pid): one vibestd per VIBEST_HOME, and a socket that something else answers on is never
// unlinked. Real vibestd processes on temporary VIBEST_HOMEs, in real time; never the user's.
import { assert, describe, it } from "@effect/vitest"
import { awaitDaemon, probe } from "@vibest/client/client"
import { layer as builtinHarnesses } from "@vibest/core/harnesses"
import { Layout, VibestCommand } from "@vibest/core/paths"
import { type Host, readDaemonInfo, run } from "@vibest/server/daemon"
import { ConfigProvider, Effect, Exit, Fiber, FileSystem, Layer, Option, Scope } from "effect"
import { SocketServer } from "effect/socket/SocketServer"

import * as Platform from "#platform"

import { pingOf, runVibest, tempDirectory } from "./fakes.ts"

/**
 * `vibest daemon --foreground` on its own VIBEST_HOME, with nothing of this test run's environment but a PATH that has
 * no harness CLI. The subscription poll runs real commands for whatever is installed; this keeps it off the user's.
 */
const daemon = (home: string) =>
  runVibest(home, { HOME: home, VIBEST_HOME: home, PATH: "/usr/bin:/bin" }, ["daemon", "--foreground"])

/** A server on `socket` that takes no lock: Ping answered like an vibestd that takes no lock, or never answered at all. */
const listen = (socket: string, answer: boolean) =>
  Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<net.Server>((resolve) => {
          const server = net.createServer((sock) => {
            let buf = ""
            sock.on("data", (chunk) => {
              buf += chunk.toString()
              const nl = buf.indexOf("\n")
              if (nl < 0 || !answer) return
              const req = JSON.parse(buf.slice(0, nl)) as { id?: string }
              sock.write(
                JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { version: "0.0.0", runtimes: [] } }) + "\n",
              )
            })
          })
          server.listen(socket, () => resolve(server))
        }),
    ),
    (server) => Effect.sync(() => server.close()),
  )

describe.concurrent("vibestd.pid lock", () => {
  it.live("a lock file this user may only read: vibestd fails as unavailable, never as a second holder", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const layout = yield* Layout.make(yield* tempDirectory("vibest-home-"))
      yield* fs.writeFileString(layout.daemonInfo, "")
      yield* fs.chmod(layout.daemonInfo, 0o400)
      const run = yield* daemon(layout.home)
      assert.strictEqual(run.code, 1)
      assert.include(run.stderr, "DaemonLockUnavailable")
      assert.include(run.stderr, "EACCES")
      assert.isFalse(yield* fs.exists(layout.database))
      assert.isFalse(yield* probe(layout.socket))
    }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )

  it.live(
    "the lock held by a process that never answers: vibestd waits, then fails without unlinking the socket",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const layout = yield* Layout.make(yield* tempDirectory("vibest-home-"))
        assert.isDefined(yield* Platform.daemon.lock(layout.daemonInfo))
        yield* fs.writeFileString(layout.socket, "")
        const run = yield* daemon(layout.home)
        assert.strictEqual(run.code, 1)
        assert.include(run.stderr, "DaemonNotAnswering")
        assert.isTrue(yield* fs.exists(layout.socket))
        assert.isFalse(yield* fs.exists(layout.database))
      }).pipe(Effect.scoped, Effect.provide(Platform.services)),
    30_000,
  )

  it.live(
    "the lock still held after the old vibestd's socket is gone (its finalizers running): the new vibestd takes it once released",
    () =>
      Effect.gen(function* () {
        const layout = yield* Layout.make(yield* tempDirectory("vibest-home-"))
        const old = yield* Scope.make()
        assert.isDefined(yield* Platform.daemon.lock(layout.daemonInfo).pipe(Effect.provideService(Scope.Scope, old)))
        const start = yield* Effect.forkScoped(daemon(layout.home))
        yield* Effect.sleep("1500 millis")
        assert.isFalse(yield* probe(layout.socket))
        yield* Scope.close(old, Exit.void)
        assert.isTrue(yield* awaitDaemon(layout.socket))
        assert.isUndefined(start.pollUnsafe())
      }).pipe(Effect.scoped, Effect.provide(Platform.services)),
    30_000,
  )

  it.live(
    "an older vibestd that takes no lock, or a socket that never answers: vibestd fails and the socket stays",
    () =>
      Effect.gen(function* () {
        for (const answer of [true, false]) {
          const layout = yield* Layout.make(yield* tempDirectory("vibest-home-"))
          yield* listen(layout.socket, answer)
          const run = yield* daemon(layout.home)
          assert.strictEqual(run.code, 1)
          assert.include(run.stderr, "DaemonSocketInUse")
          assert.include(run.stderr, answer ? "answers Ping" : "does not answer Ping")
          assert.strictEqual(yield* probe(layout.socket), answer)
          assert.isFalse(yield* (yield* FileSystem.FileSystem).exists(layout.database))
        }
      }).pipe(Effect.scoped, Effect.provide(Platform.services)),
    30_000,
  )

  it.live(
    "concurrent starts: exactly one vibestd serves, the others wait for it and exit 0",
    () =>
      Effect.gen(function* () {
        const layout = yield* Layout.make(yield* tempDirectory("vibest-home-"))
        const starts = yield* Effect.forEach([1, 2, 3, 4], () => Effect.forkScoped(daemon(layout.home)))
        assert.isTrue(yield* awaitDaemon(layout.socket))
        const ping = yield* pingOf(layout.socket)
        // The 10s bound is how long the three that must exit may take. The one that keeps serving is not a wait.
        const running = [...starts]
        const exited: Array<{ readonly code: number; readonly stdout: string; readonly stderr: string }> = []
        for (const deadline = Date.now() + 10_000; running.length > 1 && Date.now() < deadline;) {
          for (let i = running.length - 1; i >= 0; i--) {
            if (running[i]!.pollUnsafe() === undefined) continue
            exited.push(yield* Fiber.join(running.splice(i, 1)[0]!))
          }
          if (running.length > 1) yield* Effect.sleep("20 millis")
        }
        assert.strictEqual(exited.length, 3)
        assert.strictEqual(running.length, 1)
        assert.isUndefined(running[0]!.pollUnsafe())
        for (const run of exited) {
          assert.strictEqual(run.code, 0)
          assert.include(run.stdout + run.stderr, "already running")
        }
        assert.strictEqual(Platform.liveness(ping.pid!), "alive")
        assert.strictEqual(Option.getOrThrow(yield* readDaemonInfo(layout.daemonInfo)).instance, ping.instance)
      }).pipe(Effect.scoped, Effect.provide(Platform.services)),
    30_000,
  )

  it.live(
    "an vibestd killed with SIGKILL, its PID in vibestd.pid now another live process: the next vibestd starts and signals nobody",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const layout = yield* Layout.make(yield* tempDirectory("vibest-home-"))
        const first = yield* Effect.forkScoped(daemon(layout.home))
        assert.isTrue(yield* awaitDaemon(layout.socket))
        const old = yield* pingOf(layout.socket)
        process.kill(old.pid!, "SIGKILL")
        // Its runVibest dies on the signal; only the exit matters.
        yield* Fiber.await(first)
        assert.strictEqual(Platform.liveness(old.pid!), "exited")
        assert.isTrue(yield* fs.exists(layout.socket))
        // The PID reused by a process that is not vibestd: this test's own.
        const info = Option.getOrThrow(yield* readDaemonInfo(layout.daemonInfo))
        yield* fs.writeFileString(layout.daemonInfo, JSON.stringify({ ...info, pid: process.pid }))
        yield* Effect.forkScoped(daemon(layout.home))
        assert.isTrue(yield* awaitDaemon(layout.socket))
        const next = yield* pingOf(layout.socket)
        assert.notStrictEqual(next.instance, old.instance)
        assert.notStrictEqual(next.pid, process.pid)
      }).pipe(Effect.scoped, Effect.provide(Platform.services)),
    30_000,
  )

  it.live(
    "an vibestd that fails to start leaves the lock free for the next one",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const layout = yield* Layout.make(yield* tempDirectory("vibest-home-"))
        yield* fs.makeDirectory(layout.database, { recursive: true })
        const failed = yield* daemon(layout.home)
        assert.notStrictEqual(failed.code, 0)
        assert.isFalse(yield* probe(layout.socket))
        yield* fs.remove(layout.database, { recursive: true })
        yield* Effect.forkScoped(daemon(layout.home))
        assert.isTrue(yield* awaitDaemon(layout.socket))
      }).pipe(Effect.scoped, Effect.provide(Platform.services)),
    30_000,
  )

  it.live(
    "an vibestd slow to close its socket keeps the lock until the socket is gone: its successor binds after, and stays reachable",
    () =>
      Effect.gen(function* () {
        const layout = yield* Layout.make(yield* tempDirectory("vibest-home-"))
        // The old vibestd in this process, its socket server taking 1.5 s to close (the delay runs before Bun's close and unlink).
        const slowClose: Host = {
          ...Platform.daemon,
          socketServer: (path) =>
            Layer.effect(
              SocketServer,
              Effect.gen(function* () {
                const server = yield* SocketServer
                yield* Effect.addFinalizer(() => Effect.sleep("1500 millis"))
                return server
              }),
            ).pipe(Layer.provide(Platform.daemon.socketServer(path))),
        }
        const old = yield* run(slowClose).pipe(
          Effect.provideService(Layout, layout),
          Effect.provideService(VibestCommand, ["vibestd-under-test"]),
          Effect.provide(builtinHarnesses),
          Effect.provide(
            ConfigProvider.layer(ConfigProvider.fromUnknown({ HOME: layout.home, PATH: "/usr/bin:/bin" })),
          ),
          Effect.forkScoped,
        )
        assert.isTrue(yield* awaitDaemon(layout.socket))
        const stopping = yield* Effect.forkScoped(Fiber.interrupt(old))
        yield* Effect.sleep("200 millis")
        const successor = yield* Effect.forkScoped(daemon(layout.home))
        yield* Fiber.join(stopping)
        assert.isTrue(yield* awaitDaemon(layout.socket))
        yield* Effect.sleep("500 millis")
        const ping = yield* pingOf(layout.socket)
        assert.notStrictEqual(ping.pid, process.pid)
        assert.strictEqual(Platform.liveness(ping.pid!), "alive")
        assert.isUndefined(successor.pollUnsafe())
      }).pipe(Effect.scoped, Effect.provide(Platform.services)),
    30_000,
  )

  // An unreferenced handle is collected within seconds and its lock goes with it, while its process lives (on Linux in
  // 1.9-2.9 s with no forced GC). The adapter's handle is captured by the finalizer that closes it, so it lives as long
  // as vibestd's scope does. The control shows this pressure does collect a handle nobody keeps.
  it.live(
    "the lock is held for the scope and readable meanwhile: another process stays BUSY until the scope closes, then the file is empty",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const layout = yield* Layout.make(yield* tempDirectory("vibest-home-"))
        const contender = (file: string) =>
          childProcess
            .execFileSync(process.execPath, [`${import.meta.dirname}/lock-contender.ts`, file], {
              encoding: "utf8",
              timeout: 10_000,
            })
            .trim()
        yield* Effect.gen(function* () {
          const write = yield* Platform.daemon.lock(layout.daemonInfo)
          yield* write!('{"pid":1}')
          assert.strictEqual(yield* fs.readFileString(layout.daemonInfo), '{"pid":1}')
          for (let i = 0; i < 3; i++) {
            Bun.gc(true)
            assert.strictEqual(contender(layout.daemonInfo), "BUSY")
            yield* Effect.sleep("300 millis")
          }
        }).pipe(Effect.scoped)
        assert.strictEqual(yield* fs.readFileString(layout.daemonInfo), "")
        assert.strictEqual(contender(layout.daemonInfo), "ACQUIRED")
      }).pipe(Effect.scoped, Effect.provide(Platform.services)),
    30_000,
  )
})
