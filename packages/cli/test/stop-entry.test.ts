import { assert, describe, it } from "@effect/vitest"
import { cliHeaders, connect } from "@vibest/client/client"
import { Bus } from "@vibest/core/bus"
import { Db, encodeAddress, harnessIdOf, placedTerminal, runtimeOf, terminalOf } from "@vibest/core/db"
import { Layout } from "@vibest/core/paths"
import { Processes } from "@vibest/core/processes"
import { Project } from "@vibest/core/project"
import { HARNESS_EXIT_WAIT } from "@vibest/core/remove"
import { unwrapped } from "@vibest/core/replies"
import { SessionLive } from "@vibest/core/session/live"
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
  TEST_HERDR,
  testLayer,
  type TestOptions,
  type TestServices,
  until,
  untilVirtual,
  projectOf,
  processesOn,
} from "./fakes.ts"

const served = (options: TestOptions) =>
  Server.layer.pipe(
    Layer.provide(Layer.unwrap(Effect.map(Layout, (layout) => Platform.socketServer(layout.socket)))),
    Layer.provideMerge(Project.layer),
    Layer.provideMerge(testLayer(options)),
  )

const test = <E>(
  name: string,
  program: Effect.Effect<void, E, TestServices | FakeProcesses | Project | Scope.Scope>,
  options: TestOptions = {},
) => it.effect(name, () => program.pipe(Effect.provide(served(options))), 20_000)

const client = Effect.flatMap(Layout, (layout) => connect(layout.socket))

const refuseRealKills = Effect.acquireRelease(
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

const workingPiEntry = Effect.gen(function* () {
  yield* refuseRealKills
  const db = yield* Db
  const herdr = yield* FakeRuntime
  const processes = yield* FakeProcesses
  const repo = yield* makeRepository
  const c = authed(yield* client, cliHeaders(repo))
  const paneId = "test/p1"
  yield* herdr.seedAgent(paneId)
  yield* herdr.updateAgent(paneId, (a) => ({ ...a, status: "working" }))
  yield* processes.set(HARNESS, "alive")
  const started = yield* c["Project.EntrySession"]({
    agent: "coordinator",
    harness: "pi",
    fresh: false,
    terminal: paneId,
    runtime: TEST_HERDR,
    pid: HARNESS,
  })
  yield* db.noteConversation(started.sessionId, "conversation-1")
  const projectId = yield* projectOf(repo)
  const entry = (yield* db.entryOf(projectId))!
  const origin = { runtime: runtimeOf(entry), address: terminalOf(entry) }
  const address = encodeAddress(origin.address)
  yield* db.insertSession(
    {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
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
      executionState: "none",
      executionPromptedAt: 0,
      createdAt: 1,
      lastActive: 1,
    },
    projectId,
    { parentSessionId: entry.id },
  )
  yield* db.insertInbox({
    sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    message: "waiting for the entry session",
  })
  const stop = c["Project.StopEntry"]({ runtime: origin.runtime, address })
  const startAt = (terminal: string, harness: "pi" | "claude" = "pi") =>
    c["Project.EntrySession"]({ agent: "coordinator", harness, fresh: false, terminal, runtime: TEST_HERDR, pid: 5151 })
  const pending = Effect.map(entryPending(db, projectId), (rows) => rows.map((r) => unwrapped(r.message)))
  return { db, herdr, processes, c, paneId, origin, projectId, started, stop, startAt, pending }
})

describe("Project.StopEntry moves the entry session: SIGTERM to the recorded harness PID only, never a group or the terminal; what waits is kept for the next launch", () => {
  it.effect(
    "terminate signals one valid PID: ESRCH is sent; EPERM or anything else, or an invalid PID, is denied",
    () =>
      Effect.gen(function* () {
        yield* refuseRealKills
        const asked: Array<number> = []
        const processes = yield* Effect.gen(function* () {
          return yield* Processes
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
    "y: SIGTERM to the harness PID only (after a restart in place, the pid it reported ready with), its terminal kept; its exit and a delivery before the launch drop nothing; the start in another terminal resumes the same conversation and gets what waited",
    Effect.gen(function* () {
      const s = yield* workingPiEntry
      yield* s.processes.set(7777, "alive")
      yield* s.db.patchLive(s.started.sessionId, { pid: 7777 })
      assert.deepStrictEqual(yield* s.stop, { result: "stopped" })
      assert.deepStrictEqual(yield* s.processes.signaled, [7777])
      assert.deepStrictEqual(yield* s.herdr.callsTo("close"), [])
      assert.deepStrictEqual(yield* s.herdr.callsTo("send"), [])
      assert.isTrue(HashMap.has(yield* s.herdr.panes, s.paneId))
      yield* s.herdr.updateAgent(s.paneId, (a) => ({ ...a, alive: false }))
      yield* untilVirtual(s.pending, (rows) => rows.length === 1)
      assert.deepStrictEqual(yield* s.pending, ["waiting for the entry session"])
      const moved = yield* s.startAt("test/p2")
      assert.deepInclude(moved, { sessionId: s.started.sessionId, harnessSessionId: "conversation-1" })
      const row = (yield* s.db.entryOf(s.projectId))!
      assert.strictEqual(terminalOf(row)?.id, "test/p2")
      assert.strictEqual(row.process?.pid, 5151)
      assert.deepStrictEqual(yield* s.pending, ["waiting for the entry session"])
    }),
    { statusEvents: true },
  )

  test(
    "y with another harness: the same entry session, a new conversation for that harness",
    Effect.gen(function* () {
      const s = yield* workingPiEntry
      assert.deepStrictEqual(yield* s.stop, { result: "stopped" })
      assert.deepInclude(yield* s.startAt("test/p2", "claude"), {
        sessionId: s.started.sessionId,
        harnessSessionId: null,
      })
      assert.strictEqual(harnessIdOf((yield* s.db.entryOf(s.projectId))!), "claude")
    }),
  )

  test(
    "while a restart is between its harnesses: a start elsewhere is refused even with no agent seen, and the move is unsupported",
    Effect.gen(function* () {
      const s = yield* workingPiEntry
      yield* (yield* SessionLive).restarting.mark(s.started.sessionId)
      yield* s.herdr.updateAgent(s.paneId, (a) => ({ ...a, alive: false }))
      const refused = yield* Effect.exit(s.startAt("test/p2"))
      assert.isTrue(Exit.isFailure(refused))
      assert.include(String(Cause.squash((refused as Exit.Failure<unknown, unknown>).cause)), "still running in")
      assert.deepInclude(yield* s.stop, { result: "unsupported" })
      assert.deepStrictEqual(yield* s.processes.signaled, [])
      assert.strictEqual(terminalOf((yield* s.db.entryOf(s.projectId))!)?.id, s.paneId)
    }),
  )

  test(
    "a harness that ignores SIGTERM: running after about 10 s, the row back at its terminal, nothing dropped, and the start elsewhere still refused",
    Effect.gen(function* () {
      const s = yield* workingPiEntry
      yield* s.processes.setSignalIgnored(true)
      const stopping = yield* Effect.forkChild(s.stop)
      yield* untilVirtual(
        Effect.sync(() => stopping.pollUnsafe()),
        (exit) => exit !== undefined,
      )
      assert.deepStrictEqual(yield* Fiber.join(stopping), { result: "running" })
      assert.deepStrictEqual(yield* s.processes.signaled, [HARNESS])
      const row = (yield* s.db.entryOf(s.projectId))!
      assert.strictEqual(terminalOf(row)?.id, s.paneId)
      assert.strictEqual(row.process?.conversation ?? null, "conversation-1")
      assert.deepStrictEqual(yield* s.pending, ["waiting for the entry session"])
      const refused = yield* Effect.exit(s.startAt("test/p2"))
      assert.isTrue(Exit.isFailure(refused))
      assert.include(String(Cause.squash((refused as Exit.Failure<unknown, unknown>).cause)), "still running in")
    }),
  )

  test(
    "stopped as soon as the runtime reports the harness's exit, with no clock advance, while its PID still reads alive",
    Effect.gen(function* () {
      const s = yield* workingPiEntry
      yield* s.processes.setSignalIgnored(true)
      const stopping = yield* Effect.forkChild(s.stop)
      yield* until(s.processes.signaled, (pids) => pids.length === 1)
      yield* (yield* Bus).observe({
        type: "terminal.exited",
        runtime: s.origin.runtime,
        terminal: { machine: "local", id: s.paneId },
      })
      assert.deepStrictEqual(yield* Fiber.join(stopping), { result: "stopped" })
    }),
  )

  test(
    "a harness that exits without an event is stopped at the deadline's last look",
    Effect.gen(function* () {
      const s = yield* workingPiEntry
      yield* s.processes.setSignalIgnored(true)
      const stopping = yield* Effect.forkChild(s.stop)
      yield* until(s.processes.signaled, (pids) => pids.length === 1)
      yield* s.processes.set(HARNESS, "exited")
      yield* TestClock.adjust(HARNESS_EXIT_WAIT)
      assert.deepStrictEqual(yield* Fiber.join(stopping), { result: "stopped" })
    }),
  )

  test(
    "the CLI interrupted (Ctrl-C) after the detach: the stop still finishes, the row is back at its terminal, and a start elsewhere is still refused",
    Effect.gen(function* () {
      const s = yield* workingPiEntry
      yield* s.processes.setSignalIgnored(true)
      const stopping = yield* Effect.forkChild(s.stop)
      yield* untilVirtual(s.db.entryOf(s.projectId), (row) => row !== undefined && placedTerminal(row) === undefined)
      yield* Fiber.interrupt(stopping)
      yield* untilVirtual(
        s.db.entryOf(s.projectId),
        (row) => row !== undefined && placedTerminal(row)?.address.id === s.paneId,
      )
      assert.deepStrictEqual(yield* s.processes.signaled, [HARNESS])
      assert.deepStrictEqual(yield* s.pending, ["waiting for the entry session"])
      const refused = yield* Effect.exit(s.startAt("test/p2"))
      assert.isTrue(Exit.isFailure(refused))
      assert.include(String(Cause.squash((refused as Exit.Failure<unknown, unknown>).cause)), "still running in")
    }),
  )

  test(
    "nothing signalled: a row that moved, a denied signal; unsupported with why: a PID never recorded (an older vibest), or no agent seen but a live (reused) PID; an exited PID moves without a signal",
    Effect.gen(function* () {
      const s = yield* workingPiEntry
      const restore = s.db.startEntry(s.projectId, "pi", false, s.origin, { agent: "coordinator", pid: HARNESS })
      yield* s.db.startEntry(
        s.projectId,
        "pi",
        false,
        {
          ...s.origin,
          address: { machine: "local", id: "test/p9" },
        },
        { agent: "coordinator" },
      )
      assert.deepStrictEqual(yield* s.stop, { result: "moved" })
      yield* s.db.startEntry(s.projectId, "pi", false, s.origin, { agent: "coordinator" })
      const old = yield* s.stop
      assert.strictEqual(old.result, "unsupported")
      assert.include(old.reason, "started by an older vibest")
      yield* restore
      yield* s.processes.setSignalDenied(true)
      assert.deepStrictEqual(yield* s.stop, { result: "running" })
      yield* s.processes.setSignalDenied(false)
      yield* s.herdr.updateAgent(s.paneId, (a) => ({ ...a, alive: false }))
      yield* s.herdr.addPane(s.paneId, "test", "/")
      const unseen = yield* s.stop
      assert.strictEqual(unseen.result, "unsupported")
      assert.include(unseen.reason, "does not see its harness")
      assert.deepStrictEqual(yield* s.processes.signaled, [])
      assert.strictEqual(terminalOf((yield* s.db.entryOf(s.projectId))!)?.id, s.paneId)
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
          Effect.exit(
            c["Project.EntrySession"]({
              agent: "coordinator",
              harness: "pi",
              fresh: false,
              terminal,
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
