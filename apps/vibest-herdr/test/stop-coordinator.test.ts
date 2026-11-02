// Project.StopCoordinator on the production handler: the harness's interrupt key through the runtime, then until the
// agent is no longer working; a coordinator that changes while the runtime call is in flight is not interrupted, and the
// terminal is never closed. These tests must not signal a real process group: process.kill of a termination signal or a
// non-positive pid throws.
import { assert, describe, it } from "@effect/vitest"
import * as Platform from "#platform"
import { Effect, Fiber, HashMap, Layer, type Scope } from "effect"
import { cliHeaders, connect } from "@vibest/client/client"
import { Db, encodeAddress } from "@vibest/core/db"
import { Layout } from "@vibest/core/paths"
import { Processes } from "@vibest/core/processes"
import { Project } from "@vibest/core/project"
import * as Server from "@vibest/server/server"
import { repositoryKey } from "@vibest/core/worktree"
import { authed, FakeRuntime, makeRepository, TEST_HERDR, testLayer, type TestServices, until, untilVirtual } from "./fakes.ts"

const served = () =>
  Server.layer.pipe(
    Layer.provide(Layer.unwrap(Effect.map(Layout, (layout) => Platform.daemon.socketServer(layout.socket)))),
    Layer.provideMerge(Project.layer),
    Layer.provideMerge(testLayer()),
  )

const test = <E>(name: string, program: Effect.Effect<void, E, TestServices | Project | Scope.Scope>, timeout?: number) =>
  it.effect(name, () => program.pipe(Effect.provide(served())), timeout)

const client = Effect.flatMap(Layout, (layout) => connect(layout.socket))

/** A termination signal, or any signal to a process group, fails the test instead of being sent. */
const refuseTerminationSignals = Effect.acquireRelease(
  Effect.sync(() => {
    const real = process.kill
    process.kill = ((pid: number, signal?: string | number) => {
      const terminal = signal === undefined || signal === "SIGTERM" || signal === "SIGKILL" || signal === "SIGHUP" || signal === 15 || signal === 9 || signal === 1
      if (pid <= 0 || terminal) throw new Error(`refused to signal ${pid} with ${String(signal)}`)
      return real(pid, signal)
    }) as typeof process.kill
    return real
  }),
  (real) => Effect.sync(() => {
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
  const started = yield* c["Project.CoordinatorSession"]({ harness: "pi", fresh: false, terminal: paneId, runtime: TEST_HERDR })
  const identity = yield* db.sessionIdentity(started.sessionId)
  const coord = identity ? yield* db.coordinatorOf(identity.projectId) : undefined
  if (!identity || !coord?.runtime || !coord.address?.id) return yield* Effect.die("coordinator was not recorded")
  const origin = { runtime: coord.runtime, address: coord.address }
  const address = encodeAddress(origin.address)
  const key = yield* repositoryKey(repo)
  return { db, herdr, c, paneId, origin, address, key, otherKey: yield* repositoryKey(yield* makeRepository) }
})

describe("Project.StopCoordinator", () => {
  it.effect("terminateGroup ignores only ESRCH; EPERM or anything else is denied, and an invalid group is not asked", () =>
    Effect.gen(function* () {
      yield* refuseTerminationSignals
      const asked: Array<number> = []
      const processes = yield* Effect.gen(function* () { return yield* Processes }).pipe(
        Effect.provide(Processes.layer({
          liveness: () => "exited",
          terminateGroup: (group) => {
            asked.push(group)
            if (group === 42) throw Object.assign(new Error("gone"), { code: "ESRCH" })
            if (group === 99) throw Object.assign(new Error("denied"), { code: "EPERM" })
            if (group === 100) throw new Error("boom")
          },
          pid: 1,
          uid: undefined,
        })),
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
    "moved or absent while the runtime call is in flight: moved, with one key typed to the terminal the stop knew",
    Effect.gen(function* () {
      const s = yield* launched
      const { db, herdr, c, origin, address, key, otherKey } = s
      const changes = [
        ["terminal", db.coordinatorLaunch(key, "pi", false, { ...origin, address: { ...origin.address, id: "test/p9" } })],
        ["machine", db.coordinatorLaunch(key, "pi", false, { ...origin, address: { ...origin.address, machine: "elsewhere" } })],
        ["runtime", db.coordinatorLaunch(key, "pi", false, { runtime: "other-runtime", address: origin.address })],
        ["project", db.coordinatorLaunch(otherKey, "pi", false, { runtime: origin.runtime, address: origin.address })],
        ["absent", db.clearCoordinator(origin.runtime, origin.address)],
      ] as const
      const blocks = [
        ["send", () => herdr.hold("send")],
        ["state", () => herdr.hold("state")],
      ] as const
      const restore = db.coordinatorLaunch(key, "pi", false, origin)
      for (const [awaited, block] of blocks) {
        for (const [change, mutate] of changes) {
          yield* restore
          const typedBefore = (yield* herdr.callsTo("send")).length
          const held = yield* block()
          const stopping = yield* Effect.forkChild(c["Project.StopCoordinator"]({ runtime: origin.runtime, address }))
          yield* held.reached.pipe(Effect.andThen(mutate), Effect.ensuring(held.release()))
          assert.deepStrictEqual(yield* Fiber.join(stopping), { result: "moved" }, `${change} during ${awaited}`)
          // The key went to the terminal the stop knew; the move seen afterwards aborts without another one.
          const typed = (yield* herdr.callsTo("send")).length - typedBefore
          assert.strictEqual(typed, 1, `${change} during ${awaited}`)
        }
      }
      assert.deepStrictEqual(yield* herdr.callsTo("close"), [])
      assert.isTrue(HashMap.has(yield* herdr.panes, s.paneId))
    }),
    20_000,
  )

  test(
    "the agent keeps working past the wait: running, one interrupt key, terminal kept",
    Effect.gen(function* () {
      const { herdr, c, paneId, origin, address } = yield* launched
      yield* herdr.updateAgent(paneId, (a) => ({ ...a, status: "working" }))
      const settling = yield* herdr.hold("state")
      const stopping = yield* Effect.forkChild(c["Project.StopCoordinator"]({ runtime: origin.runtime, address }))
      yield* until(herdr.callsTo("send"), (calls) => calls.length === 1)
      // The interrupt key does not take: before the first state read, the agent is working again, and stays so.
      yield* settling.reached
      yield* herdr.updateAgent(paneId, (a) => ({ ...a, status: "working" }))
      yield* settling.release()
      yield* untilVirtual(Effect.sync(() => stopping.pollUnsafe()), (exit) => exit !== undefined)
      assert.deepStrictEqual(yield* Fiber.join(stopping), { result: "running" })
      assert.deepStrictEqual(yield* herdr.callsTo("send"), [{ terminal: paneId, keys: ["esc"] }])
      assert.deepStrictEqual(yield* herdr.callsTo("close"), [])
      assert.isTrue(HashMap.has(yield* herdr.panes, paneId))
    }),
    20_000,
  )

  test(
    "the agent settles after the key: stopped, one interrupt key, terminal kept",
    Effect.gen(function* () {
      const { herdr, c, paneId, origin, address } = yield* launched
      const stopping = yield* Effect.forkChild(c["Project.StopCoordinator"]({ runtime: origin.runtime, address }))
      yield* until(herdr.callsTo("send"), (calls) => calls.length === 1)
      yield* herdr.updateAgent(paneId, (a) => ({ ...a, status: "idle" }))
      assert.deepStrictEqual(yield* Fiber.join(stopping), { result: "stopped" })
      assert.deepStrictEqual(yield* herdr.callsTo("send"), [{ terminal: paneId, keys: ["esc"] }])
      assert.deepStrictEqual(yield* herdr.callsTo("close"), [])
      assert.isTrue(HashMap.has(yield* herdr.panes, paneId))
    }),
    20_000,
  )
})
