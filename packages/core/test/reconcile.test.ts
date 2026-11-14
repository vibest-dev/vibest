import { assert, describe } from "@effect/vitest"
import { Db } from "@vibest/core/database/db"
import { exitedAt } from "@vibest/core/database/db-rows"
import { Session, START_TIMEOUT } from "@vibest/core/session"
import { Effect } from "effect"
import { TestClock } from "effect/testing"

import { projectOf } from "./lib/directory.ts"
import { testEffect } from "./lib/effect.ts"
import { FakeRuntime } from "./lib/fake-runtime.ts"
import { until } from "./lib/observe.ts"
import { makeRepository, restartSessions, sessionFrom } from "./lib/session.ts"

const TEST_HERDR = "herdr"

const test = <E, R>(name: string, program: Effect.Effect<void, E, R>) =>
  testEffect(sessionFrom({ hooked: ["pi"] }))(name, () => program)

const startupSettled = (sessions: Session.Interface) => until(sessions.inMemory, (memory) => memory.reconciles >= 1)

describe("reconcile: a terminal whose agent has not started", () => {
  test(
    "a pending launch is checked again after the start timeout, and ended once the runtime says it is gone",
    Effect.gen(function* () {
      const db = yield* Db
      const herdr = yield* FakeRuntime
      const repo = yield* makeRepository
      const projectId = yield* projectOf(repo)
      const id = "cccccccc-cccc-4ccc-8ccc-000000000001"
      yield* herdr.addPane("w8:pending", "w8", repo)
      yield* startupSettled(yield* Session.Service)
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
      assert.isNull(exitedAt((yield* db.getSession(id))!))
      yield* herdr.seedAgent("w8:pending")
      yield* herdr.updateAgent("w8:pending", (agent) => ({ ...agent, alive: false }))
      assert.isNull(exitedAt((yield* db.getSession(id))!))
      yield* TestClock.adjust(START_TIMEOUT)
      yield* until(db.getSession(id), (session) => (session ? exitedAt(session) : undefined) != null)
    }),
  )
})
