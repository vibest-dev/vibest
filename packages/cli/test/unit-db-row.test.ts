import { assert, it } from "@effect/vitest"
import { Db } from "@vibest/core/database/db"
import { KIND as RUNTIME } from "@vibest/runtime-herdr/terminal-runtime"
import { Effect } from "effect"

import { projectOf } from "./fakes.ts"
import { database, place, session } from "./unit-helpers.ts"

it.effect("a session row's open execution is the newest one and its last execution the one that ended before", () =>
  Effect.gen(function* () {
    const db = yield* Db
    const project = yield* projectOf("r")
    const child = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    const parent = (yield* db.session.startEntry(project, "pi", false, place, { agent: "coordinator" })).sessionId
    yield* db.session.insertSession(session(child, { address: { machine: "local", id: "" } }), project, {
      parentSessionId: parent,
    })
    yield* db.session.placeProcess(child, "t1", 42)
    const first = (yield* db.session.startExecution(child, 5)).execution
    yield* db.session.endExecution(
      child,
      { outcome: "failed", failure: { message: "rate_limit", kind: "limit" } },
      undefined,
      9,
    )
    const second = (yield* db.session.startExecution(child, 12)).execution
    const row = (yield* db.session.getSession(child))!
    assert.strictEqual(row.openExecution!.id, second)
    assert.deepInclude(row.lastExecution!, { id: first, outcome: "failed" })
  }).pipe(Effect.provide(database(":memory:"))),
)

it.effect("sessionAt finds the one live session at that runtime and terminal", () =>
  Effect.gen(function* () {
    const db = yield* Db
    const project = yield* projectOf("r")
    const here = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    const terminal = { machine: "local", id: "pane-a" }
    yield* db.session.insertSession(
      session("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", {
        address: { machine: "local", id: "pane-b" },
        createdAt: 0,
      }),
      project,
    )
    yield* db.session.insertSession(
      session("cccccccc-cccc-4ccc-8ccc-cccccccccccc", { runtime: "other", address: terminal, createdAt: 0 }),
      project,
    )
    yield* db.session.insertSession(
      session("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", { address: terminal, exitedAt: 5, createdAt: 0 }),
      project,
    )
    yield* db.session.insertSession(session(here, { address: terminal, createdAt: 1 }), project)
    assert.strictEqual(yield* db.session.sessionAt(RUNTIME, terminal), here)
    assert.isUndefined(yield* db.session.sessionAt(RUNTIME, { machine: "local", id: "missing" }))
  }).pipe(Effect.provide(database(":memory:"))),
)
