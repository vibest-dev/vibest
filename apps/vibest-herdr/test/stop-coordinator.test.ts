// Project.StopCoordinator on the production handler: the runtime closes the main agent's terminal, then until nothing
// runs there (gone is the only success, so a second live main agent never starts); a coordinator that changes while the
// runtime call is in flight reads moved. These tests must not signal a real process group: process.kill of a termination
// signal or a non-positive pid throws.
import { assert, describe, it } from "@effect/vitest"
import { cliHeaders, connect } from "@vibest/client/client"
import { Db, encodeAddress } from "@vibest/core/db"
import { Layout } from "@vibest/core/paths"
import { Processes } from "@vibest/core/processes"
import { Project } from "@vibest/core/project"
import { repositoryKey } from "@vibest/core/worktree"
import * as Server from "@vibest/server/server"
import { Cause, Effect, Exit, Fiber, HashMap, Layer, type Scope } from "effect"

import * as Platform from "#platform"

import {
  authed,
  FakeRuntime,
  makeRepository,
  TEST_HERDR,
  testLayer,
  type TestOptions,
  type TestServices,
  until,
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
  program: Effect.Effect<void, E, TestServices | Project | Scope.Scope>,
  timeout?: number,
  options: TestOptions = {},
) => it.effect(name, () => program.pipe(Effect.provide(served(options))), timeout)

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

/** The coordinator's terminal: a pi main agent at work in it, and the address StopCoordinator is asked about. */
const launched = Effect.gen(function* () {
  yield* refuseTerminationSignals
  const db = yield* Db
  const herdr = yield* FakeRuntime
  const repo = yield* makeRepository
  const c = authed(yield* client, cliHeaders(repo))
  const paneId = "test/p1"
  yield* herdr.seedAgent(paneId)
  yield* herdr.updateAgent(paneId, (a) => ({ ...a, status: "working" }))
  const started = yield* c["Project.CoordinatorSession"]({
    harness: "pi",
    fresh: false,
    terminal: paneId,
    runtime: TEST_HERDR,
  })
  const identity = yield* db.sessionIdentity(started.sessionId)
  const coord = identity ? yield* db.coordinatorOf(identity.projectId) : undefined
  if (!identity || !coord?.runtime || !coord.address?.id) return yield* Effect.die("coordinator was not recorded")
  const origin = { runtime: coord.runtime, address: coord.address }
  const address = encodeAddress(origin.address)
  const key = yield* repositoryKey(repo)
  return { db, herdr, c, paneId, origin, address, key, otherKey: yield* repositoryKey(yield* makeRepository) }
})

describe("Project.StopCoordinator", () => {
  it.effect(
    "terminateGroup ignores only ESRCH; EPERM or anything else is denied, and an invalid group is not asked",
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
              terminateGroup: (group) => {
                asked.push(group)
                if (group === 42) throw Object.assign(new Error("gone"), { code: "ESRCH" })
                if (group === 99) throw Object.assign(new Error("denied"), { code: "EPERM" })
                if (group === 100) throw new Error("boom")
              },
              pid: 1,
              uid: undefined,
            }),
          ),
          Effect.provide(Platform.services),
        )
        assert.strictEqual(yield* processes.terminateGroup(0), "denied")
        assert.strictEqual(yield* processes.terminateGroup(-1), "denied")
        assert.strictEqual(yield* processes.terminateGroup(42), "sent")
        assert.strictEqual(yield* processes.terminateGroup(99), "denied")
        assert.strictEqual(yield* processes.terminateGroup(100), "denied")
        assert.deepStrictEqual(asked, [42, 99, 100])
      }).pipe(Effect.provide(Platform.services)),
  )

  test(
    "the row moved or is gone before the stop: moved, nothing closed; a terminal where the runtime sees no agent: running, nothing closed",
    Effect.gen(function* () {
      const s = yield* launched
      const { db, herdr, c, origin, address, key, otherKey } = s
      const changes = [
        [
          "terminal",
          db.coordinatorLaunch(key, "pi", false, { ...origin, address: { ...origin.address, id: "test/p9" } }),
        ],
        [
          "machine",
          db.coordinatorLaunch(key, "pi", false, { ...origin, address: { ...origin.address, machine: "elsewhere" } }),
        ],
        ["runtime", db.coordinatorLaunch(key, "pi", false, { runtime: "other-runtime", address: origin.address })],
        ["project", db.coordinatorLaunch(otherKey, "pi", false, { runtime: origin.runtime, address: origin.address })],
        ["absent", db.clearCoordinator(origin.runtime, origin.address)],
      ] as const
      const restore = db.coordinatorLaunch(key, "pi", false, origin)
      for (const [change, mutate] of changes) {
        yield* restore
        // Held at the agent read, the first runtime call: the row changes before the stop looks at it.
        const held = yield* herdr.hold("state", s.paneId)
        const stopping = yield* Effect.forkChild(c["Project.StopCoordinator"]({ runtime: origin.runtime, address }))
        yield* held.reached.pipe(Effect.andThen(mutate), Effect.ensuring(held.release()))
        assert.deepStrictEqual(yield* Fiber.join(stopping), { result: "moved" }, change)
      }
      yield* restore
      // The harness exited unseen and the user runs something else there: the runtime names no agent, a program runs.
      yield* herdr.updateAgent(s.paneId, (a) => ({ ...a, alive: false }))
      yield* herdr.addPane(s.paneId, "test", "/")
      assert.deepStrictEqual(yield* c["Project.StopCoordinator"]({ runtime: origin.runtime, address }), {
        result: "running",
      })
      assert.deepStrictEqual(yield* herdr.callsTo("close"), [])
      assert.deepStrictEqual(yield* herdr.callsTo("send"), [])
      assert.isTrue(HashMap.has(yield* herdr.panes, s.paneId))
    }),
    20_000,
  )

  test(
    "the harness outlives the close (the runtime refused it): running after the wait, and the project still refuses a second main agent",
    Effect.gen(function* () {
      const { herdr, c, paneId, origin, address } = yield* launched
      const closing = yield* herdr.hold("close", paneId)
      const stopping = yield* Effect.forkChild(c["Project.StopCoordinator"]({ runtime: origin.runtime, address }))
      yield* closing.reached
      yield* closing.release("failed")
      yield* untilVirtual(
        Effect.sync(() => stopping.pollUnsafe()),
        (exit) => exit !== undefined,
      )
      assert.deepStrictEqual(yield* Fiber.join(stopping), { result: "running" })
      assert.isTrue(HashMap.has(yield* herdr.panes, paneId))
      const refused = yield* Effect.exit(
        c["Project.CoordinatorSession"]({ harness: "pi", fresh: false, terminal: "test/p2", runtime: TEST_HERDR }),
      )
      assert.isTrue(Exit.isFailure(refused))
      assert.include(String(Cause.squash((refused as Exit.Failure<unknown, unknown>).cause)), "still running in")
    }),
    20_000,
  )

  test(
    "an idle main agent: stopped only once its terminal is gone, no key typed; then another terminal starts it",
    Effect.gen(function* () {
      const { db, herdr, c, paneId, origin, address, key } = yield* launched
      yield* herdr.updateAgent(paneId, (a) => ({ ...a, status: "idle" }))
      assert.deepStrictEqual(yield* c["Project.StopCoordinator"]({ runtime: origin.runtime, address }), {
        result: "stopped",
      })
      assert.deepStrictEqual(yield* herdr.callsTo("send"), [])
      assert.deepStrictEqual(yield* herdr.callsTo("close"), [{ terminal: paneId }])
      assert.isFalse(HashMap.has(yield* herdr.panes, paneId))
      assert.isNull(yield* c["Project.RunningCoordinator"]({ terminal: "test/p2" }))
      yield* c["Project.CoordinatorSession"]({ harness: "pi", fresh: false, terminal: "test/p2", runtime: TEST_HERDR })
      assert.strictEqual((yield* db.coordinatorOf(yield* db.projectId(key)))!.address?.id, "test/p2")
    }),
    20_000,
  )

  test(
    "the close's own exited event clears the row first: still stopped, and another terminal starts it",
    Effect.gen(function* () {
      const { db, herdr, c, paneId, origin, address, key } = yield* launched
      const projectId = yield* db.projectId(key)
      // Held at the first liveness read after the close, until the exited event has cleared the row.
      const reading = yield* herdr.hold("process", paneId)
      const stopping = yield* Effect.forkChild(c["Project.StopCoordinator"]({ runtime: origin.runtime, address }))
      yield* reading.reached
      yield* until(db.coordinatorOf(projectId), (row) => !row?.address || row.address.id === "")
      yield* reading.release()
      assert.deepStrictEqual(yield* Fiber.join(stopping), { result: "stopped" })
      yield* c["Project.CoordinatorSession"]({ harness: "pi", fresh: false, terminal: "test/p2", runtime: TEST_HERDR })
      assert.strictEqual((yield* db.coordinatorOf(projectId))!.address?.id, "test/p2")
    }),
    20_000,
    { statusEvents: true },
  )
})
