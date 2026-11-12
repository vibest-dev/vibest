import { assert, describe } from "@effect/vitest"
import { Db } from "@vibest/core/db"
import { Integration } from "@vibest/core/integration"
import { Sessions } from "@vibest/core/sessions"
import { Subscriptions } from "@vibest/core/subscriptions/service"
import { Effect } from "effect"
import { TestClock } from "effect/testing"

import { KIND as RUNTIME } from "../../runtime-herdr/src/terminal-runtime.ts"
import { projectOf } from "./lib/directory.ts"
import { FakeRuntime } from "./lib/fake-runtime.ts"
import { until, writeEnd } from "./lib/observe.ts"
import { makeRepository } from "./lib/session.ts"
import { chooseNext, harnessOf, limited, spawnInput, test } from "./lib/sessions-helpers.ts"

const entryWorking = Effect.gen(function* () {
  const db = yield* Db
  const herdr = yield* FakeRuntime
  const sessions = yield* Sessions
  const entry = yield* db.startEntry(
    yield* projectOf(yield* makeRepository),
    "pi",
    false,
    { runtime: RUNTIME, address: { machine: "local", id: "test/coord" } },
    { agent: "coordinator" },
  )
  yield* herdr.seedAgent("test/coord")
  yield* (yield* Integration).ready(entry.sessionId, undefined)
  yield* sessions.userPrompt(entry.sessionId, "hello")
  yield* herdr.updateAgent("test/coord", (agent) => ({ ...agent, status: "working", seq: agent.seq + 1 }))
  return { db, herdr, sessions, id: entry.sessionId }
})

const settle = (herdr: FakeRuntime["Service"]) =>
  herdr.updateAgent("test/coord", (agent) => ({ ...agent, status: "idle", seq: agent.seq + 1 }))

describe.concurrent("the entry session is an ordinary session", () => {
  test(
    "an entry session records the execution its input opens and judges it lost when the end never arrives",
    Effect.gen(function* () {
      const { db, herdr, sessions, id } = yield* entryWorking
      assert.deepInclude(yield* db.getSession(id), { executionState: "open" })
      yield* settle(herdr)
      yield* sessions.check(id)
      yield* TestClock.adjust("11 seconds")
      yield* sessions.check(id)
      assert.deepInclude(yield* db.getSession(id), { executionState: "lost" })
    }),
  )

  test(
    "an entry session whose execution hits a usage limit does not switch harness",
    Effect.gen(function* () {
      const { db, herdr, sessions, id } = yield* entryWorking
      yield* (yield* Subscriptions).report({ harness: "pi", limits: [limited] })
      yield* settle(herdr)
      yield* writeEnd(id, "pi", { error: "rate_limit" })
      yield* sessions.check(id)
      assert.deepInclude(yield* db.getSession(id), { harnessId: "pi", executionState: "failed" })
      assert.deepStrictEqual(
        (yield* herdr.callsTo("open")).map((call) => harnessOf(call.argv)),
        [],
      )
    }),
    { plugins: [chooseNext] },
  )

  test(
    "a session started on another machine, known only by its origin session, switches harness on a usage limit",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const db = yield* Db
      const sessions = yield* Sessions
      const repo = yield* makeRepository
      const { parentSessionId: _, ...input } = yield* spawnInput(repo)
      const { id } = yield* sessions.spawn({
        ...input,
        origin: { peer: "a".repeat(32), project: "p", reportTo: "away" },
      })
      yield* until(db.getSession(id), (row) => row?.startedAt !== null)
      yield* sessions.check(id)
      yield* (yield* Integration).ready(id, undefined)
      yield* (yield* Subscriptions).report({ harness: "pi", limits: [limited] })
      yield* herdr.endExecution(id)
      yield* writeEnd(id, "pi", { error: "rate_limit" })
      yield* sessions.check(id)
      assert.notStrictEqual((yield* db.getSession(id))!.harnessId, "pi")
    }),
    { plugins: [chooseNext] },
  )
})
