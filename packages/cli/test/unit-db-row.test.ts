import { assert, it } from "@effect/vitest"
import { Db } from "@vibest/core/database/db"
import { Effect } from "effect"

import { projectOf } from "./fakes.ts"
import { database, place, session } from "./unit-helpers.ts"

it.effect("a session row's open execution is the newest one and its last execution the one that ended before", () =>
  Effect.gen(function* () {
    const db = yield* Db
    const project = yield* projectOf("r")
    const child = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    const parent = (yield* db.startEntry(project, "pi", false, place, { agent: "coordinator" })).sessionId
    yield* db.insertSession(session(child, { address: { machine: "local", id: "" } }), project, {
      parentSessionId: parent,
    })
    yield* db.placeProcess(child, "t1", 42)
    const first = (yield* db.startExecution(child, 5)).execution
    yield* db.endExecution(
      child,
      { outcome: "failed", failure: { message: "rate_limit", kind: "limit" } },
      undefined,
      9,
    )
    const second = (yield* db.startExecution(child, 12)).execution
    const row = (yield* db.getSession(child))!
    assert.strictEqual(row.openExecution!.id, second)
    assert.deepInclude(row.lastExecution!, { id: first, outcome: "failed" })
  }).pipe(Effect.provide(database(":memory:"))),
)
