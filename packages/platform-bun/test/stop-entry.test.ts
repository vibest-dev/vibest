import { assert, describe, it } from "@effect/vitest"
import { cliHeaders, connect } from "@vibest/client/client"
import { Bus } from "@vibest/core/bus"
import { Db } from "@vibest/core/database/db"
import { harnessIdOf, placedTerminal, runtimeOf, terminalOf } from "@vibest/core/database/db-rows"
import { Processes } from "@vibest/core/processes"
import { Project } from "@vibest/core/project"
import { unwrapped } from "@vibest/core/replies"
import { SessionLive } from "@vibest/core/session/live"
import { HARNESS_EXIT_WAIT } from "@vibest/core/session/release"
import { Layout } from "@vibest/schema/layout"
import * as Server from "@vibest/server/server"
import { Cause, Effect, Exit, Fiber, HashMap, Layer, type Scope } from "effect"
import { TestClock } from "effect/testing"

import * as Platform from "#platform"

import {
  authed,
  entryPending,
  FakeProcesses,
  FakeRuntime,
  makeRepository,
  processesOn,
  projectOf,
  TEST_HERDR,
  testLayer,
  type TestOptions,
  type TestServices,
  until,
  untilVirtual,
} from "./lib/fakes.ts"

const refuseRealKills = Effect.gen(function* () {
  const real = process.kill.bind(process)
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      process.kill = ((pid: number, signal?: string | number) => {
        throw new Error(`test called real process.kill(${pid}, ${String(signal)})`)
      }) as typeof process.kill
    }),
    () =>
      Effect.sync(() => {
        process.kill = real
      }),
  )
})

const served = (options?: TestOptions) =>
  Server.layer.pipe(
    Layer.provide(Layer.unwrap(Effect.map(Layout, (layout) => Platform.socketServer(layout.socket)))),
    Layer.provideMerge(Project.layer),
    Layer.provideMerge(testLayer(options)),
  )

const test = <E>(
  name: string,
  program: Effect.Effect<void, E, TestServices | Project.Service | Scope.Scope>,
  options?: TestOptions,
) => it.effect(name, () => program.pipe(Effect.provide(served(options))))

const client = Effect.flatMap(Layout, (layout) => connect(layout.socket))

const HARNESS = 4242

const workingPiRoot = Effect.gen(function* () {
  yield* refuseRealKills
  const db = yield* Db.Service
  const herdr = yield* FakeRuntime
  const processes = yield* FakeProcesses
  const repo = yield* makeRepository
  const c = authed(yield* client, cliHeaders(repo))
  const paneId = "test/p1"
  yield* herdr.seedAgent(paneId)
  yield* herdr.updateAgent(paneId, (a) => ({ ...a, status: "working" }))
  yield* processes.set(HARNESS, "alive")

  const started = yield* c["Session.Claim"]({
    agent: "coordinator",
    harness: "pi",
    fresh: false,
    terminal: { id: paneId },
    runtime: TEST_HERDR,
    pid: HARNESS,
  })

  yield* db.session.noteConversation(started.sessionId, "conversation-1")
  const projectId = yield* projectOf(repo)
  const root = (yield* db.session.latestRoot(projectId))!
  const origin = { runtime: runtimeOf(root), target: terminalOf(root)!.target }
  yield* db.session.insertSession(
    {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      agent: "general",
      name: "n",
      harnessId: "pi",
      provider: null,
      model: null,
      harnessSessionId: null,
      runtime: TEST_HERDR,
      terminal: { id: "test/p0" },
      status: "idle",
      startedAt: 1,
      exitedAt: null,
      executionState: "none",
      executionPromptedAt: 0,
      createdAt: 1,
      lastActive: 1,
    },
    projectId,
    { parentSessionId: root.id },
  )
  yield* db.inbox.insertInbox({
    sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    message: "waiting for the root session",
  })

  const moveTo = (terminal: string, harness: "pi" | "claude" = "pi") =>
    c["Session.Claim"]({
      sessionId: started.sessionId,
      agent: "coordinator",
      harness,
      fresh: false,
      move: true,
      terminal: { id: terminal },
      runtime: TEST_HERDR,
      pid: 5151,
    })

  const startAt = (terminal: string, harness: "pi" | "claude" = "pi") =>
    c["Session.Claim"]({
      agent: "coordinator",
      harness,
      fresh: false,
      terminal: { id: terminal },
      runtime: TEST_HERDR,
      pid: 5151,
    })

  const pending = Effect.map(entryPending(db, projectId), (rows) => rows.map((r) => unwrapped(r.message)))

  return { db, herdr, processes, c, paneId, origin, projectId, started, moveTo, startAt, pending }
})

describe("Session.Claim move: SIGTERM to the recorded harness PID only, never a group or the terminal; what waits is kept for the next launch", () => {
  it.effect(
    "terminate signals one valid PID: ESRCH is sent; EPERM or anything else, or an invalid PID, is denied",
    () =>
      Effect.gen(function* () {
        yield* refuseRealKills
        const asked: Array<number> = []

        const processes = yield* Effect.gen(function* () {
          return yield* Processes.Service
        }).pipe(
          Effect.provide(
            processesOn({
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
    "move: SIGTERM to the harness PID only, its terminal kept, resumes the same conversation and keeps pending messages",
    Effect.gen(function* () {
      const s = yield* workingPiRoot
      yield* s.processes.set(7777, "alive")
      yield* s.db.session.patchLive(s.started.sessionId, { pid: 7777 })
      const moved = yield* s.moveTo("test/p2")
      assert.deepStrictEqual(yield* s.processes.signaled, [7777])
      assert.deepStrictEqual(yield* s.herdr.callsTo("close"), [])
      assert.deepStrictEqual(yield* s.herdr.callsTo("send"), [])
      assert.isTrue(HashMap.has(yield* s.herdr.panes, s.paneId))
      assert.deepInclude(moved, { sessionId: s.started.sessionId, harnessSessionId: "conversation-1" })
      const row = (yield* s.db.session.latestRoot(s.projectId))!
      assert.strictEqual(terminalOf(row)?.target["id"], "test/p2")
      assert.strictEqual(row.process?.pid, 5151)
      assert.deepStrictEqual(yield* s.pending, ["waiting for the root session"])
    }),
    { statusEvents: true },
  )

  test(
    "move with another harness: the same root session, a new conversation for that harness",
    Effect.gen(function* () {
      const s = yield* workingPiRoot
      assert.deepInclude(yield* s.moveTo("test/p2", "claude"), {
        sessionId: s.started.sessionId,
        harnessSessionId: null,
      })
      assert.strictEqual(harnessIdOf((yield* s.db.session.latestRoot(s.projectId))!), "claude")
    }),
  )

  test(
    "while a restart is between its harnesses: a start elsewhere is refused even with no agent seen, and the move is unsupported",
    Effect.gen(function* () {
      const s = yield* workingPiRoot
      yield* (yield* SessionLive.Service).restarting.mark(s.started.sessionId)
      yield* s.herdr.updateAgent(s.paneId, (a) => ({ ...a, alive: false }))
      const refused = yield* Effect.exit(s.startAt("test/p2"))
      assert.isTrue(Exit.isFailure(refused))
      assert.include(String(Cause.squash((refused as Exit.Failure<unknown, unknown>).cause)), "still running in")
      const moved = yield* Effect.exit(s.moveTo("test/p2"))
      assert.isTrue(Exit.isFailure(moved))
      assert.include(String(Cause.squash((moved as Exit.Failure<unknown, unknown>).cause)), "cannot be moved")
      assert.deepStrictEqual(yield* s.processes.signaled, [])
      assert.strictEqual(terminalOf((yield* s.db.session.latestRoot(s.projectId))!)?.target["id"], s.paneId)
    }),
  )

  test(
    "a harness that ignores SIGTERM: move fails after wait, the row stays at its terminal, nothing dropped",
    Effect.gen(function* () {
      const s = yield* workingPiRoot
      yield* s.processes.setSignalIgnored(true)
      const moving = yield* Effect.forkChild(Effect.exit(s.moveTo("test/p2")))
      yield* untilVirtual(
        Effect.sync(() => moving.pollUnsafe()),
        (exit) => exit !== undefined,
      )
      const result = yield* Fiber.join(moving)
      assert.isTrue(Exit.isFailure(result))
      assert.include(String(Cause.squash((result as Exit.Failure<unknown, unknown>).cause)), "did not exit")
      assert.deepStrictEqual(yield* s.processes.signaled, [HARNESS])
      const row = (yield* s.db.session.latestRoot(s.projectId))!
      assert.strictEqual(terminalOf(row)?.target["id"], s.paneId)
      assert.strictEqual(row.process?.harnessSessionId ?? null, "conversation-1")
      assert.deepStrictEqual(yield* s.pending, ["waiting for the root session"])
    }),
  )

  test(
    "move completes as soon as the runtime reports the harness exit, with no clock advance, while its PID still reads alive",
    Effect.gen(function* () {
      const s = yield* workingPiRoot
      yield* s.processes.setSignalIgnored(true)
      const moving = yield* Effect.forkChild(s.moveTo("test/p2"))
      yield* until(s.processes.signaled, (pids) => pids.length === 1)
      const terminal = { id: s.paneId }
      yield* (yield* Bus.Service).observe({
        type: "terminal.exited",
        runtime: s.origin.runtime,
        terminal,
        processes: yield* (yield* Db.Service).session.processesAt(s.origin.runtime, terminal),
      })
      const moved = yield* Fiber.join(moving)
      assert.strictEqual(moved.sessionId, s.started.sessionId)
    }),
  )

  test(
    "a harness that exits without an event is moved at the deadline last look",
    Effect.gen(function* () {
      const s = yield* workingPiRoot
      yield* s.processes.setSignalIgnored(true)
      const moving = yield* Effect.forkChild(s.moveTo("test/p2"))
      yield* until(s.processes.signaled, (pids) => pids.length === 1)
      yield* s.processes.set(HARNESS, "exited")
      yield* TestClock.adjust(HARNESS_EXIT_WAIT)
      const moved = yield* Fiber.join(moving)
      assert.strictEqual(moved.sessionId, s.started.sessionId)
    }),
  )

  test(
    "the CLI interrupted after detach: the row is back at its terminal, and a start elsewhere is still refused",
    Effect.gen(function* () {
      const s = yield* workingPiRoot
      yield* s.processes.setSignalIgnored(true)
      const moving = yield* Effect.forkChild(s.moveTo("test/p2"))
      yield* untilVirtual(
        s.db.session.latestRoot(s.projectId),
        (row) => row !== undefined && placedTerminal(row) === undefined,
      )
      yield* Fiber.interrupt(moving)
      yield* untilVirtual(
        s.db.session.latestRoot(s.projectId),
        (row) => row !== undefined && placedTerminal(row)?.target["id"] === s.paneId,
      )
      assert.deepStrictEqual(yield* s.processes.signaled, [HARNESS])
      assert.deepStrictEqual(yield* s.pending, ["waiting for the root session"])
      const refused = yield* Effect.exit(s.startAt("test/p2"))
      assert.isTrue(Exit.isFailure(refused))
      assert.include(String(Cause.squash((refused as Exit.Failure<unknown, unknown>).cause)), "still running in")
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
          Effect.exit(
            c["Session.Claim"]({
              agent: "coordinator",
              harness: "pi",
              fresh: false,
              terminal: { id: terminal },
              runtime: TEST_HERDR,
            }),
          ),
        ),
        { concurrency: "unbounded" },
      )

      assert.deepStrictEqual(exits.map((e) => Exit.isSuccess(e)).toSorted(), [false, true])
    }),
  )
})
