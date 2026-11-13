import { describe } from "@effect/vitest"
import { Db, executionStateOf } from "@vibest/core/db"
import { Effect } from "effect"

import { FakeRuntime } from "./lib/fake-runtime.ts"
import { PI, RUNTIME_ONLY } from "./lib/harnesses.ts"
import { until } from "./lib/observe.ts"
import { makeRepository } from "./lib/session.ts"
import { spawnWorking, test } from "./lib/sessions-helpers.ts"

const options = { harnesses: [PI, RUNTIME_ONLY], statusEvents: true }

const stateOf = (id: string) =>
  Effect.gen(function* () {
    return executionStateOf((yield* (yield* Db).getSession(id))!)
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
})
