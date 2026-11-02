// Project.StopCoordinator on the production handler: `vibest` moving the project's main agent to its own terminal.
// SIGTERM goes to the harness's recorded PID only (never a group, never the terminal), then until it exited; what waits
// for the main agent is kept for the launch that follows. These tests must not signal a real process: process.kill of a
// termination signal or a non-positive pid throws.
import { assert, describe, it } from "@effect/vitest"
import { cliHeaders, connect } from "@vibest/client/client"
import { Db, encodeAddress } from "@vibest/core/db"
import { Inbox } from "@vibest/core/inbox"
import { Layout } from "@vibest/core/paths"
import { Processes } from "@vibest/core/processes"
import { Project } from "@vibest/core/project"
import { repositoryKey } from "@vibest/core/worktree"
import * as Server from "@vibest/server/server"
import { Cause, Deferred, Effect, Exit, Fiber, HashMap, Layer, type Scope } from "effect"

import * as Platform from "#platform"

import {
  authed,
  FakeProcesses,
  FakeRuntime,
  makeRepository,
  TEST_HERDR,
  testLayer,
  type TestOptions,
  type TestServices,
  untilVirtual,
} from "./fakes.ts"

const served = (options: TestOptions) =>
  Server.layer.pipe(
    Layer.provide(Layer.unwrap(Effect.map(Layout, (layout) => Platform.daemon.socketServer(layout.socket)))),
    Layer.provideMerge(Project.layer),
    Layer.provideMerge(testLayer(options)),
  )

const test = <E>(
  name: string,
  program: Effect.Effect<void, E, TestServices | FakeProcesses | Project | Scope.Scope>,
  options: TestOptions = {},
) => it.effect(name, () => program.pipe(Effect.provide(served(options))), 20_000)

const client = Effect.flatMap(Layout, (layout) => connect(layout.socket))

/** A termination signal, or any signal to a process group, fails the test instead of being sent. */
const refuseTerminationSignals = Effect.acquireRelease(
  Effect.sync(() => {
    const real = process.kill
    process.kill = ((pid: number, signal?: string | number) => {
      const terminal =
        signal === undefined ||
        signal === "SIGTERM" ||
        signal === "SIGKILL" ||
        signal === "SIGHUP" ||
        signal === 15 ||
        signal === 9 ||
        signal === 1
      if (pid <= 0 || terminal) throw new Error(`refused to signal ${pid} with ${String(signal)}`)
      return real(pid, signal)
    }) as typeof process.kill
    return real
  }),
  (real) =>
    Effect.sync(() => {
      process.kill = real
    }),
)

const HARNESS = 4242

/**
 * A pi main agent at work in test/p1, its harness PID recorded and alive, and a notice waiting for it (pi takes rows
 * only through its subscription, and none is open: the row stays pending).
 */
const launched = Effect.gen(function* () {
  yield* refuseTerminationSignals
  const db = yield* Db
  const herdr = yield* FakeRuntime
  const processes = yield* FakeProcesses
  const repo = yield* makeRepository
  const c = authed(yield* client, cliHeaders(repo))
  const paneId = "test/p1"
  yield* herdr.seedAgent(paneId)
  yield* herdr.updateAgent(paneId, (a) => ({ ...a, status: "working" }))
  yield* processes.set(HARNESS, "alive")
  const started = yield* c["Project.CoordinatorSession"]({
    harness: "pi",
    fresh: false,
    terminal: paneId,
    runtime: TEST_HERDR,
    pid: HARNESS,
  })
  yield* db.reportCoordinatorSession(started.sessionId, "pi", "conversation-1")
  const key = yield* repositoryKey(repo)
  const projectId = yield* db.projectId(key)
  const coord = (yield* db.coordinatorOf(projectId))!
  const origin = { runtime: coord.runtime!, address: coord.address! }
  const address = encodeAddress(origin.address)
  yield* db.insertSession(
    {
      id: "aaaaaaaa",
      agent: "general",
      name: "n",
      harnessId: "pi",
      provider: null,
      model: null,
      harnessSessionId: null,
      runtime: TEST_HERDR,
      address: { machine: "local", id: "test/p0" },
      status: "idle",
      startedAt: 1,
      exitedAt: null,
      turnState: "none",
      turnPromptedAt: 0,
      metadata: {},
      createdAt: 1,
      lastActive: 1,
    },
    key,
  )
  yield* db.insertInbox({ sessionId: "aaaaaaaa", kind: "notice", message: "waiting for the main agent", details: {} })
  const stop = c["Project.StopCoordinator"]({ runtime: origin.runtime, address })
  const startAt = (terminal: string, harness: "pi" | "claude" = "pi") =>
    c["Project.CoordinatorSession"]({ harness, fresh: false, terminal, runtime: TEST_HERDR, pid: 5151 })
  const pending = Effect.map(db.coordinatorPending(projectId), (rows) => rows.map((r) => r.message))
  return { db, herdr, processes, c, paneId, origin, key, projectId, started, stop, startAt, pending }
})

describe("Project.StopCoordinator", () => {
  it.effect(
    "terminate signals one valid PID: ESRCH is sent; EPERM or anything else, or an invalid PID, is denied",
    () =>
      Effect.gen(function* () {
        yield* refuseTerminationSignals
        const asked: Array<number> = []
        const processes = yield* Effect.gen(function* () {
          return yield* Processes
        }).pipe(
          Effect.provide(
            Processes.layer({
              liveness: () => "exited",
              terminate: (pid) => {
                asked.push(pid)
                if (pid === 42) throw Object.assign(new Error("gone"), { code: "ESRCH" })
                if (pid === 99) throw Object.assign(new Error("denied"), { code: "EPERM" })
                if (pid === 100) throw new Error("boom")
              },
              pid: 1,
              uid: undefined,
            }),
          ),
          Effect.provide(Platform.services),
        )
        for (const pid of [0, -1, 1.5, 1]) assert.strictEqual(yield* processes.terminate(pid), "denied", `${pid}`)
        assert.strictEqual(yield* processes.terminate(42), "sent")
        assert.strictEqual(yield* processes.terminate(99), "denied")
        assert.strictEqual(yield* processes.terminate(100), "denied")
        assert.strictEqual(yield* processes.terminate(7), "sent")
        assert.deepStrictEqual(asked, [42, 99, 100, 7])
      }).pipe(Effect.provide(Platform.services)),
  )

  test(
    "y: SIGTERM to the harness PID only, its terminal kept; its exit drops nothing; the start in another terminal resumes the same conversation and gets what waited",
    Effect.gen(function* () {
      const s = yield* launched
      assert.deepStrictEqual(yield* s.stop, { result: "stopped" })
      assert.deepStrictEqual(yield* s.processes.signaled, [HARNESS])
      assert.deepStrictEqual(yield* s.herdr.callsTo("close"), [])
      assert.deepStrictEqual(yield* s.herdr.callsTo("send"), [])
      assert.isTrue(HashMap.has(yield* s.herdr.panes, s.paneId))
      // The harness exits; the pane stays at its shell, and the runtime says its agent is gone.
      yield* s.herdr.updateAgent(s.paneId, (a) => ({ ...a, alive: false }))
      // A delivery round while it has no place (between the stop and the launch) keeps its rows too.
      yield* (yield* Inbox).deliver(s.projectId)
      yield* untilVirtual(s.pending, (rows) => rows.length === 1)
      assert.deepStrictEqual(yield* s.pending, ["waiting for the main agent"])
      const moved = yield* s.startAt("test/p2")
      assert.deepStrictEqual(moved, { sessionId: s.started.sessionId, harnessSessionId: "conversation-1" })
      const row = (yield* s.db.coordinatorOf(s.projectId))!
      assert.strictEqual(row.address?.id, "test/p2")
      assert.strictEqual(row.pid, 5151)
      assert.deepStrictEqual(yield* s.pending, ["waiting for the main agent"])
    }),
    { statusEvents: true },
  )

  test(
    "y with another harness: the same main session, a new conversation for that harness",
    Effect.gen(function* () {
      const s = yield* launched
      assert.deepStrictEqual(yield* s.stop, { result: "stopped" })
      assert.deepStrictEqual(yield* s.startAt("test/p2", "claude"), {
        sessionId: s.started.sessionId,
        harnessSessionId: null,
      })
      assert.strictEqual((yield* s.db.coordinatorOf(s.projectId))!.harnessId, "claude")
    }),
  )

  test(
    "a harness that ignores SIGTERM: running after about 10 s, the row back at its terminal, nothing dropped, and the start elsewhere still refused",
    Effect.gen(function* () {
      const s = yield* launched
      yield* s.processes.setSignalIgnored(true)
      const stopping = yield* Effect.forkChild(s.stop)
      yield* untilVirtual(
        Effect.sync(() => stopping.pollUnsafe()),
        (exit) => exit !== undefined,
      )
      assert.deepStrictEqual(yield* Fiber.join(stopping), { result: "running" })
      assert.deepStrictEqual(yield* s.processes.signaled, [HARNESS])
      const row = (yield* s.db.coordinatorOf(s.projectId))!
      assert.strictEqual(row.address?.id, s.paneId)
      assert.strictEqual(row.harnessSessionId, "conversation-1")
      assert.deepStrictEqual(yield* s.pending, ["waiting for the main agent"])
      const refused = yield* Effect.exit(s.startAt("test/p2"))
      assert.isTrue(Exit.isFailure(refused))
      assert.include(String(Cause.squash((refused as Exit.Failure<unknown, unknown>).cause)), "still running in")
    }),
  )

  test(
    "nothing signalled: a row that moved, a denied signal; unsupported with why: a PID never recorded, a remote machine, or no agent seen but a live PID",
    Effect.gen(function* () {
      const s = yield* launched
      const restore = s.db.coordinatorLaunch(s.key, "pi", false, s.origin, { pid: HARNESS })
      yield* s.db.coordinatorLaunch(s.key, "pi", false, { ...s.origin, address: { machine: "local", id: "test/p9" } })
      assert.deepStrictEqual(yield* s.stop, { result: "moved" })
      // No PID recorded (a main agent started by an older vibest).
      yield* s.db.coordinatorLaunch(s.key, "pi", false, s.origin)
      const old = yield* s.stop
      assert.strictEqual(old.result, "unsupported")
      assert.include(old.reason, "started by an older vibest")
      // Another machine: its PID means nothing here.
      const remote = { ...s.origin, address: { machine: "elsewhere", id: s.paneId } }
      yield* s.db.coordinatorLaunch(s.key, "pi", false, remote, { pid: HARNESS })
      const far = yield* s.c["Project.StopCoordinator"]({
        runtime: remote.runtime,
        address: encodeAddress(remote.address),
      })
      assert.strictEqual(far.result, "unsupported")
      assert.include(far.reason, "another machine")
      yield* restore
      yield* s.processes.setSignalDenied(true)
      assert.deepStrictEqual(yield* s.stop, { result: "running" })
      yield* s.processes.setSignalDenied(false)
      // The harness exited unseen and a program of the user's runs there: its PID reads alive (reused), so left alone.
      yield* s.herdr.updateAgent(s.paneId, (a) => ({ ...a, alive: false }))
      yield* s.herdr.addPane(s.paneId, "test", "/")
      const unseen = yield* s.stop
      assert.strictEqual(unseen.result, "unsupported")
      assert.include(unseen.reason, "does not see its harness")
      assert.deepStrictEqual(yield* s.processes.signaled, [])
      assert.strictEqual((yield* s.db.coordinatorOf(s.projectId))!.address?.id, s.paneId)
      // Its PID exited: the harness is already gone, so it moves without a signal.
      yield* s.processes.set(HARNESS, "exited")
      assert.deepStrictEqual(yield* s.stop, { result: "stopped" })
      assert.deepStrictEqual(yield* s.processes.signaled, [])
    }),
  )

  test(
    "two first starts at once in two terminals: the project lock lets exactly one through",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const repo = yield* makeRepository
      const c = authed(yield* client, cliHeaders(repo))
      for (const pane of ["test/p1", "test/p2"]) yield* herdr.seedAgent(pane)
      const exits = yield* Effect.all(
        ["test/p1", "test/p2"].map((terminal) =>
          Effect.exit(c["Project.CoordinatorSession"]({ harness: "pi", fresh: false, terminal, runtime: TEST_HERDR })),
        ),
        { concurrency: "unbounded" },
      )
      assert.deepStrictEqual(exits.map((e) => Exit.isSuccess(e)).toSorted(), [false, true])
    }),
  )

  it.effect("the project lock runs one body per key at a time and drops a key once nobody holds or waits for it", () =>
    Effect.gen(function* () {
      const lock = Server.keyedLock()
      const order: Array<string> = []
      const gate = yield* Deferred.make<void>()
      const first = yield* Effect.forkChild(
        lock("p", Effect.sync(() => order.push("first in")).pipe(Effect.andThen(Deferred.await(gate)))),
      )
      yield* Effect.yieldNow
      const second = yield* Effect.forkChild(
        lock(
          "p",
          Effect.sync(() => order.push("second in")),
        ),
      )
      const failed = yield* Effect.exit(lock("q", Effect.fail("boom")))
      yield* Effect.yieldNow
      assert.deepStrictEqual(order, ["first in"])
      assert.isTrue(Exit.isFailure(failed))
      assert.strictEqual(lock.size(), 1)
      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.join(first)
      yield* Fiber.join(second)
      assert.deepStrictEqual(order, ["first in", "second in"])
      assert.strictEqual(lock.size(), 0)
    }),
  )
})
