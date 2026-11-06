import { assert, describe, it } from "@effect/vitest"
import { Bus } from "@vibest/core/bus"
import { Db } from "@vibest/core/db"
import { Runtimes } from "@vibest/core/runtimes"
import { Sessions } from "@vibest/core/sessions"
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

const stateAndProcessReadsOfOurTerminals = Effect.gen(function* () {
  const herdr = yield* FakeRuntime
  const ours = (calls: ReadonlyArray<{ readonly terminal: string }>) =>
    calls.filter((call) => call.terminal.startsWith("w9:")).length
  return ours(yield* herdr.callsTo("state")) + ours(yield* herdr.callsTo("process"))
})

describe("reconcile: one look at every live session at start, when a runtime registers, and on live.reset; nothing reads a runtime in between", () => {
  test(
    "50 idle sessions: one read each when the next vibestd starts over their rows, then none over an idle hour",
    Effect.gen(function* () {
      yield* idleSubagentsBetweenTurns(50)
      yield* Sessions.make({ maxSessions: undefined })
      yield* until(stateAndProcessReadsOfOurTerminals, (n) => n >= 50)
      yield* settled
      assert.strictEqual(yield* stateAndProcessReadsOfOurTerminals, 50)
      for (let minute = 0; minute < 60; minute++) {
        yield* TestClock.adjust("1 minute")
        yield* settled
      }
      assert.strictEqual(yield* stateAndProcessReadsOfOurTerminals, 50)
    }),
  )

  test(
    "a runtime registered after the start is reconciled: each of its sessions is read once",
    Effect.gen(function* () {
      const read = yield* Ref.make<ReadonlyArray<string>>([])
      yield* idleSubagentsBetweenTurns(3, "late")
      const late = {
        kind: "late",
        events: Stream.never,
        state: (terminal: Runtime.Terminal) =>
          Ref.update(read, (all) => [...all, terminal.id]).pipe(Effect.as("idle" as const)),
        present: () => Effect.void,
      } as unknown as Runtime.Runtime
      yield* (yield* Runtimes).register(late)
      yield* until(Ref.get(read), (all) => all.length >= 3)
      yield* settled
      assert.deepStrictEqual([...(yield* Ref.get(read))].toSorted(), ["w9:p0", "w9:p1", "w9:p2"])
    }),
  )

  test(
    "a runtime's reset reads each of its live sessions once; rows added after the start are not read before it",
    Effect.gen(function* () {
      yield* idleSubagentsBetweenTurns(4)
      yield* settled
      assert.strictEqual(yield* stateAndProcessReadsOfOurTerminals, 0)
      yield* (yield* Bus).observe({ type: "live.reset", runtime: TEST_HERDR, machine: "local" })
      yield* until(stateAndProcessReadsOfOurTerminals, (n) => n >= 4)
      yield* settled
      assert.strictEqual(yield* stateAndProcessReadsOfOurTerminals, 4)
    }),
  )
})
