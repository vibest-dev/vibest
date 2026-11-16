import { describe } from "@effect/vitest"
import { Db } from "@vibest/core/database/db"
import { executionStateOf } from "@vibest/core/database/db-rows"
import { Session } from "@vibest/core/session"
import { Effect } from "effect"

import { FakeRuntime } from "./lib/fake-runtime.ts"
import { PI, RUNTIME_ONLY } from "./lib/harnesses.ts"
import { until } from "./lib/observe.ts"
import { makeRepository, restartSessions } from "./lib/session.ts"
import { spawnWorking, test } from "./lib/sessions-helpers.ts"

const options = { harnesses: [PI, RUNTIME_ONLY], statusEvents: true }

const stateOf = (id: string) =>
  Effect.gen(function* () {
    return executionStateOf((yield* (yield* Db.Service).session.getSession(id))!)
  })

describe.concurrent("a harness without an execution-end report", () => {
  test(
    "the runtime going idle completes its execution, and work it did not start opens an execution of its own",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id } = yield* spawnWorking(yield* makeRepository, "runtime-only")
      yield* until(stateOf(id), (state) => state === "open")
      yield* herdr.endExecution(id)
      yield* until(stateOf(id), (state) => state === "completed")
      yield* herdr.updateAgent(id, (agent) => ({ ...agent, status: "working" }))
      yield* until(stateOf(id), (state) => state === "open")
      yield* herdr.endExecution(id)
      yield* until(stateOf(id), (state) => state === "completed")
    }),
    options,
  )
  test(
    "work a restarted vibestd finds running with no open execution opens one, which the next idle completes",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id } = yield* spawnWorking(yield* makeRepository, "runtime-only")
      yield* until(stateOf(id), (state) => state === "open")
      yield* herdr.endExecution(id)
      yield* (yield* Session.Service).check(id)
      yield* until(stateOf(id), (state) => state === "completed")
      yield* herdr.updateAgent(id, (agent) => ({ ...agent, status: "working" }))
      const restarted = yield* restartSessions
      yield* until(restarted.inMemory, (memory) => memory.reconciles >= 1)
      yield* until(stateOf(id), (state) => state === "open")
      yield* herdr.endExecution(id)
      yield* restarted.check(id)
      yield* until(stateOf(id), (state) => state === "completed")
    }),
    { harnesses: [PI, RUNTIME_ONLY] },
  )
})
