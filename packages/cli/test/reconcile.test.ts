import { assert, describe, it } from "@effect/vitest"
import { Db } from "@vibest/core/db"
import { Runtimes } from "@vibest/core/runtimes"
import { Sessions, START_TIMEOUT } from "@vibest/core/sessions"
import type { Runtime } from "@vibest/plugin"
import { Effect, Ref, type Scope, Stream } from "effect"
import { TestClock } from "effect/testing"

import {
  FakeRuntime,
  makeRepository,
  projectOf,
  settled,
  TEST_HERDR,
  testLayer,
  type TestServices,
  until,
} from "./fakes.ts"

const test = <E>(name: string, program: Effect.Effect<void, E, TestServices | Scope.Scope>) =>
  it.effect(name, () => program.pipe(Effect.provide(testLayer({ hooked: ["pi"] }))))

const idleSubagentsBetweenTurns = (n: number, runtime = TEST_HERDR) =>
  Effect.gen(function* () {
    const db = yield* Db
    const herdr = yield* FakeRuntime
    const projectId = yield* projectOf(yield* makeRepository)
    const ids: Array<string> = []
    for (let i = 0; i < n; i++) {
      const id = `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, "0")}`
      const terminal = `w9:p${i}`
      if (runtime === TEST_HERDR) yield* herdr.seedAgent(terminal)
      yield* db.insertSession(
        {
          id,
          agent: "general",
          name: `n${i}`,
          harnessId: "pi",
          provider: null,
          model: null,
          harnessSessionId: null,
          runtime,
          address: { machine: "local", id: terminal },
          status: "idle",
          startedAt: 1,
          exitedAt: null,
          turnState: "completed",
          turnPromptedAt: 0,
          metadata: {},
          createdAt: 1,
          lastActive: 1,
        },
        projectId,
      )
      ids.push(id)
    }
    return ids
  })

const terminalReads = Effect.gen(function* () {
  const herdr = yield* FakeRuntime
  const ours = (calls: ReadonlyArray<{ readonly terminal: string }>) =>
    calls.filter((call) => call.terminal.startsWith("w9:")).length
  return ours(yield* herdr.callsTo("state")) + ours(yield* herdr.callsTo("process"))
})

describe("reconcile: a terminal whose agent has not started", () => {
  test(
    "a runtime that reports the terminal alive with no agent process yet is left running; a terminal it cannot find is ended",
    Effect.gen(function* () {
      const db = yield* Db
      const herdr = yield* FakeRuntime
      const repo = yield* makeRepository
      const projectId = yield* projectOf(repo)
      const alive = "bbbbbbbb-bbbb-4bbb-8bbb-000000000001"
      const gone = "bbbbbbbb-bbbb-4bbb-8bbb-000000000002"
      yield* herdr.addPane("w8:starting", "w8", repo)
      const row = {
        agent: "general" as const,
        name: "starting",
        harnessId: "pi" as const,
        provider: null,
        model: null,
        harnessSessionId: null,
        runtime: TEST_HERDR,
        status: "unknown" as const,
        startedAt: 1,
        exitedAt: null,
        turnState: "open" as const,
        turnPromptedAt: 1,
        metadata: {},
        createdAt: 1,
        lastActive: 1,
      }
      yield* db.insertSession({ ...row, id: alive, address: { machine: "local", id: "w8:starting" } }, projectId, {
        cwd: repo,
      })
      yield* db.insertSession(
        { ...row, id: gone, name: "gone", address: { machine: "local", id: "w8:gone" } },
        projectId,
        { cwd: repo },
      )
      yield* Sessions.make({ maxSessions: undefined })
      yield* until(db.getSession(gone), (session) => session?.exitedAt != null)
      yield* settled
      assert.isNull((yield* db.getSession(alive))!.exitedAt)
      assert.strictEqual((yield* db.getSession(alive))!.turnState, "open")
    }),
  )

  test(
    "a pending launch is checked again after the start timeout, and ended once the runtime says it is gone",
    Effect.gen(function* () {
      const db = yield* Db
      const herdr = yield* FakeRuntime
      const repo = yield* makeRepository
      const projectId = yield* projectOf(repo)
      const id = "cccccccc-cccc-4ccc-8ccc-000000000001"
      yield* herdr.addPane("w8:pending", "w8", repo)
      yield* db.insertSession(
        {
          id,
          agent: "general",
          name: "pending",
          harnessId: "pi",
          provider: null,
          model: null,
          harnessSessionId: null,
          runtime: TEST_HERDR,
          address: { machine: "local", id: "w8:pending" },
          status: "unknown",
          startedAt: 1,
          exitedAt: null,
          turnState: "open",
          turnPromptedAt: 1,
          metadata: {},
          createdAt: 1,
          lastActive: 1,
        },
        projectId,
        { cwd: repo },
      )
      yield* Sessions.make({ maxSessions: undefined })
      yield* settled
      assert.isNull((yield* db.getSession(id))!.exitedAt)
      yield* herdr.seedAgent("w8:pending")
      yield* herdr.updateAgent("w8:pending", (agent) => ({ ...agent, alive: false }))
      yield* settled
      assert.isNull((yield* db.getSession(id))!.exitedAt)
      yield* TestClock.adjust(START_TIMEOUT)
      yield* until(db.getSession(id), (session) => session?.exitedAt != null)
    }),
  )

  test(
    "a pending launch is re-checked once, not again on the next start timeout",
    Effect.gen(function* () {
      const db = yield* Db
      const herdr = yield* FakeRuntime
      const repo = yield* makeRepository
      const projectId = yield* projectOf(repo)
      const id = "dddddddd-dddd-4ddd-8ddd-000000000001"
      const terminal = "w8:once"
      yield* herdr.addPane(terminal, "w8", repo)
      yield* db.insertSession(
        {
          id,
          agent: "general",
          name: "once",
          harnessId: "pi",
          provider: null,
          model: null,
          harnessSessionId: null,
          runtime: TEST_HERDR,
          address: { machine: "local", id: terminal },
          status: "unknown",
          startedAt: 1,
          exitedAt: null,
          turnState: "open",
          turnPromptedAt: 1,
          metadata: {},
          createdAt: 1,
          lastActive: 1,
        },
        projectId,
        { cwd: repo },
      )
      const reads = () =>
        Effect.gen(function* () {
          const state = (yield* herdr.callsTo("state")).filter((call) => call.terminal === terminal).length
          const process = (yield* herdr.callsTo("process")).filter((call) => call.terminal === terminal).length
          return state + process
        })
      yield* Sessions.make({ maxSessions: undefined })
      yield* until(reads(), (n) => n >= 2)
      yield* settled
      const afterFirst = yield* reads()
      assert.isNull((yield* db.getSession(id))!.exitedAt)
      yield* TestClock.adjust(START_TIMEOUT)
      yield* until(reads(), (n) => n > afterFirst)
      yield* settled
      const afterSecond = yield* reads()
      yield* TestClock.adjust(START_TIMEOUT)
      yield* settled
      assert.strictEqual(yield* reads(), afterSecond)
      assert.isNull((yield* db.getSession(id))!.exitedAt)
    }),
  )

  test(
    "a known state clears the one re-check, so a later pending launch is looked at again",
    Effect.gen(function* () {
      const db = yield* Db
      const herdr = yield* FakeRuntime
      const repo = yield* makeRepository
      const projectId = yield* projectOf(repo)
      const id = "eeeeeeee-eeee-4eee-8eee-000000000001"
      const terminal = "w8:again"
      yield* herdr.addPane(terminal, "w8", repo)
      yield* db.insertSession(
        {
          id,
          agent: "general",
          name: "again",
          harnessId: "pi",
          provider: null,
          model: null,
          harnessSessionId: null,
          runtime: TEST_HERDR,
          address: { machine: "local", id: terminal },
          status: "unknown",
          startedAt: 1,
          exitedAt: null,
          turnState: "open",
          turnPromptedAt: 1,
          metadata: {},
          createdAt: 1,
          lastActive: 1,
        },
        projectId,
        { cwd: repo },
      )
      const reads = () =>
        Effect.gen(function* () {
          const state = (yield* herdr.callsTo("state")).filter((call) => call.terminal === terminal).length
          const process = (yield* herdr.callsTo("process")).filter((call) => call.terminal === terminal).length
          return state + process
        })
      const sessions = yield* Sessions.make({ maxSessions: undefined })
      yield* until(reads(), (n) => n >= 2)
      yield* settled
      yield* TestClock.adjust(START_TIMEOUT)
      yield* until(reads(), (n) => n >= 4)
      yield* settled
      const spent = yield* reads()
      yield* herdr.seedAgent(terminal)
      yield* sessions.check(id)
      yield* herdr.addPane(terminal, "w8", repo)
      yield* sessions.check(id)
      yield* TestClock.adjust(START_TIMEOUT)
      yield* until(reads(), (n) => n > spent)
      yield* settled
      assert.isNull((yield* db.getSession(id))!.exitedAt)
    }),
  )
})

describe("reconcile: one look at every live session at start, when a runtime registers, and on live.reset; nothing reads a runtime in between", () => {
  test(
    "50 idle sessions: one read each when the next vibestd starts over their rows, then none over an idle hour",
    Effect.gen(function* () {
      yield* idleSubagentsBetweenTurns(50)
      yield* Sessions.make({ maxSessions: undefined })
      yield* until(terminalReads, (n) => n >= 50)
      yield* settled
      assert.strictEqual(yield* terminalReads, 50)
      for (let minute = 0; minute < 60; minute++) {
        yield* TestClock.adjust("1 minute")
        yield* settled
      }
      assert.strictEqual(yield* terminalReads, 50)
    }),
  )

  test(
    "a runtime registered after the start is reconciled: each of its sessions is read once",
    Effect.gen(function* () {
      const read = yield* Ref.make<ReadonlyArray<string>>([])
      yield* idleSubagentsBetweenTurns(3, "late")
      const late = {
        id: "late",
        events: Stream.never,
        state: (terminal: Runtime.Terminal) =>
          Ref.update(read, (all) => [...all, terminal.id]).pipe(Effect.as("idle" as const)),
        present: () => Effect.void,
      } as unknown as Runtime.RuntimeDefinition
      yield* (yield* Runtimes).transform((editor) => editor.add(late))
      yield* until(Ref.get(read), (all) => all.length >= 3)
      yield* settled
      assert.deepStrictEqual([...(yield* Ref.get(read))].toSorted(), ["w9:p0", "w9:p1", "w9:p2"])
    }),
  )
})
