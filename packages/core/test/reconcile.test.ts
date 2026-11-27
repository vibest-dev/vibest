import { assert, describe } from "@effect/vitest"
import { exitedAt } from "@vibest/core/database/rows"
import { Session, START_TIMEOUT } from "@vibest/core/session"
import { SessionStore } from "@vibest/core/session/store"
import { projectOf } from "@vibest/testkit/directory"
import { testEffect } from "@vibest/testkit/effect"
import { FakeRuntime } from "@vibest/testkit/fake-runtime"
import { until } from "@vibest/testkit/observe"
import { makeRepository, restartSessions, sessionFrom } from "@vibest/testkit/session"
import { Effect } from "effect"
import { TestClock } from "effect/testing"

const TEST_HERDR = "herdr"

const test = <E, R>(name: string, program: Effect.Effect<void, E, R>) =>
  testEffect(sessionFrom({ hooked: ["pi"] }))(name, () => program)

const startupSettled = (sessions: Session.Interface) => until(sessions.inMemory, (memory) => memory.reconciles >= 1)

describe("reconcile: a terminal whose agent has not started", () => {
  test(
    "a pending launch is checked again after the start timeout, and ended once the runtime says it is gone",
    Effect.gen(function* () {
      const sessionStore = yield* SessionStore.Service
      const herdr = yield* FakeRuntime
      const repo = yield* makeRepository
      const projectId = yield* projectOf(repo)
      const id = "cccccccc-cccc-4ccc-8ccc-000000000001"
      yield* herdr.addPane("w8:pending", "w8", repo)
      yield* startupSettled(yield* Session.Service)
      yield* sessionStore.insertSession(
        {
          id,
          agent: "general",
          name: "pending",
          harnessId: "pi",
          provider: null,
          model: null,
          harnessSessionId: null,
          runtime: TEST_HERDR,
          terminal: { id: "w8:pending" },
          status: "unknown",
          startedAt: 1,
          exitedAt: null,
          executionState: "open",
          executionPromptedAt: 1,
          createdAt: 1,
          lastActive: 1,
        },
        projectId,
        { cwd: repo },
      )
      const sessions = yield* restartSessions
      yield* startupSettled(sessions)
      assert.isNull(exitedAt((yield* sessionStore.getSession(id))!))
      yield* herdr.seedAgent("w8:pending")
      yield* herdr.updateAgent("w8:pending", (agent) => ({ ...agent, alive: false }))
      assert.isNull(exitedAt((yield* sessionStore.getSession(id))!))
      yield* TestClock.adjust(START_TIMEOUT)
      yield* until(sessionStore.getSession(id), (session) => (session ? exitedAt(session) : undefined) != null)
    }),
  )
})
