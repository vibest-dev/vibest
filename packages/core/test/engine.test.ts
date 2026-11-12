import { assert, describe } from "@effect/vitest"
import { Db } from "@vibest/core/db"
import { Harness } from "@vibest/core/harness"
import { HOOK_GRACE, Sessions } from "@vibest/core/sessions"
import { Duration, Effect } from "effect"
import { TestClock } from "effect/testing"

import { KIND as RUNTIME } from "../../runtime-herdr/src/terminal-runtime.ts"
import { projectOf } from "./lib/directory.ts"
import { testEffect } from "./lib/effect.ts"
import { FakeRuntime, type FakeRuntimeOptions } from "./lib/fake-runtime.ts"
import { harnessLayer } from "./lib/harnesses.ts"
import { settled, until } from "./lib/observe.ts"
import { makeRepository, runtimeNode, sessionLayer } from "./lib/session.ts"

const OFF_THE_POLL_BEAT = "1 second"

const withPi = (runtime: FakeRuntimeOptions) =>
  sessionLayer([
    runtimeNode.replace(FakeRuntime.layer(runtime)),
    Harness.node.replace(harnessLayer({ hooked: ["pi"] })),
  ])

const test = <E, R>(name: string, program: Effect.Effect<void, E, R>) =>
  testEffect(withPi({ statusEvents: true }))(name, () => program)

const working = Effect.gen(function* () {
  const sessions = yield* Sessions
  const db = yield* Db
  const repo = yield* makeRepository
  const projectId = yield* projectOf(repo)
  const entry = yield* db.startEntry(
    projectId,
    "pi",
    false,
    {
      runtime: RUNTIME,
      address: { machine: "local", id: "test/coord" },
    },
    { agent: "coordinator" },
  )
  const { id } = yield* sessions.spawn({
    machine: { id: "local" },
    agent: "general",
    root: repo,
    parentSessionId: entry.sessionId,
    projectId,
    name: "task",
    prompt: "do it",
    runtime: "herdr",
    harness: "pi",
  })
  yield* until(db.getSession(id), (row) => !!row && row.startedAt !== null)
  yield* settled
  return { id, sessions, db, herdr: yield* FakeRuntime }
})

describe("session handlers", () => {
  test(
    "an idle execution with no report is lost exactly HOOK_GRACE after it went idle",
    Effect.gen(function* () {
      const { id, db, herdr } = yield* working
      yield* TestClock.adjust(OFF_THE_POLL_BEAT)
      yield* herdr.endExecution(id)
      yield* settled
      yield* TestClock.adjust(Duration.subtract(HOOK_GRACE, Duration.millis(1)))
      yield* settled
      assert.strictEqual((yield* db.getSession(id))!.executionState, "open")
      yield* TestClock.adjust("1 millis")
      yield* until(db.getSession(id), (row) => row?.executionState === "lost")
    }),
  )

  testEffect(withPi({ promptsIgnored: true }))(
    "an execution start reported while the text is still being handed over confirms the launch, with no clock advance",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Sessions
        const db = yield* Db
        const herdr = yield* FakeRuntime
        const repo = yield* makeRepository
        const projectId = yield* projectOf(repo)
        yield* db.startEntry(
          projectId,
          "pi",
          false,
          {
            runtime: RUNTIME,
            address: { machine: "local", id: "test/coord" },
          },
          { agent: "coordinator" },
        )
        const held = yield* herdr.hold("send")
        const { id } = yield* sessions.spawn({
          machine: { id: "local" },
          agent: "general",
          root: repo,
          parentSessionId: "creator",
          projectId,
          name: "task",
          prompt: "do it",
          runtime: "herdr",
          harness: "pi",
        })
        yield* held.reached
        yield* sessions.userPrompt(id, "do it")
        yield* held.release()
        yield* settled
        assert.strictEqual((yield* db.getSession(id))!.executionState, "open")
        assert.isFalse(
          (yield* herdr.callsTo("send")).some((call) => call.keys !== undefined),
          "no Enter resent",
        )
      }),
  )
})
