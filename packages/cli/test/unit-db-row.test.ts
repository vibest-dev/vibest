import { assert, describe, it } from "@effect/vitest"
import { Db } from "@vibest/core/db"
import { Effect } from "effect"

import { projectOf } from "./fakes.ts"
import { database, place, session } from "./unit-helpers.ts"

describe("Db session rows", () => {
  it.effect(
    "a session row names its parent, current process, open execution and last ended execution; attempts lists its limited processes",
    () =>
      Effect.gen(function* () {
        const db = yield* Db
        const project = yield* projectOf("r")
        const child = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        const parent = (yield* db.startEntry(project, "pi", false, place, { agent: "coordinator" })).sessionId
        yield* db.insertSession(session(child, { address: { machine: "local", id: "" } }), project, {
          parentSessionId: parent,
        })
        const row = () => Effect.map(db.getSession(child), (r) => r!)
        assert.deepInclude(yield* row(), { parentId: parent, entry: false, openExecution: null, lastExecution: null })
        const first = (yield* row()).process!.id
        assert.strictEqual((yield* db.placeProcess(child, "t1", 42))!, first)
        assert.isUndefined(yield* db.placeProcess(child, "t2"))
        assert.deepInclude((yield* row()).process!, {
          id: first,
          harness: "pi",
          terminal: "t1",
          pid: 42,
          endedAt: null,
        })
        const { execution } = yield* db.startExecution(child, 5)
        assert.deepStrictEqual((yield* row()).openExecution, {
          id: execution,
          process: first,
          startedAt: 5,
          acceptedAt: null,
        })
        yield* db.endExecution(
          child,
          { outcome: "failed", failure: { message: "rate_limit", kind: "limit" } },
          undefined,
          9,
        )
        assert.deepInclude((yield* row()).lastExecution!, {
          id: execution,
          outcome: "failed",
          failure: { message: "rate_limit", kind: "limit" },
        })
        assert.isNull((yield* row()).openExecution)
        const second = (yield* db.startExecution(child, 12)).execution
        assert.strictEqual((yield* row()).openExecution!.id, second)
        assert.strictEqual((yield* row()).lastExecution!.id, execution)
        yield* db.endProcess(child, "limited")
        assert.deepStrictEqual(
          (yield* db.attempts(child)).map((a) => [a.harness, a.outcome]),
          [["pi", "limited"]],
        )
        assert.isTrue(yield* db.rename(child, "renamed"))
        assert.isFalse(yield* db.rename(child, "renamed"))
        assert.strictEqual((yield* row()).name, "renamed")
        yield* db.archive(child)
        assert.isNotNull((yield* row()).endedAt)
      }).pipe(Effect.provide(database(":memory:"))),
  )
})
