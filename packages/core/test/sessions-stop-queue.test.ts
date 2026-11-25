import { assert } from "@effect/vitest"
import { Concurrency } from "@vibest/core/runtime/concurrency"
import { Starts } from "@vibest/core/session/starts"
import { FakeRuntime } from "@vibest/testkit/fake-runtime"
import { until } from "@vibest/testkit/observe"
import { makeRepository, PluginHost } from "@vibest/testkit/session"
import { idleSession, spawnInput, test } from "@vibest/testkit/sessions-helpers"
import { Effect, Fiber } from "effect"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"

import idleStop from "../../plugin-idle-stop/src/index.ts"

for (const mode of ["direct", "plugin", "failed-close", "waiting"])
  test(
    mode,
    Effect.gen(function* () {
      const repo = yield* makeRepository
      const { id, sessions, sessionStore } = yield* idleSession(repo)
      const concurrency = yield* Concurrency.Service
      yield* concurrency.configure([{ max: 2 }])
      const starts = yield* Starts.Service
      const spawn = yield* spawnInput(repo)
      const { id: b } = yield* sessions.spawn({ ...spawn, name: "B" })
      const { id: c } = yield* sessions.spawn({ ...spawn, name: "C" })
      yield* until(starts.waiting, (ids) => ids.join() === [b, c].join())

      if (mode === "waiting") {
        const result = yield* sessions.stop(b, { type: "user" })
        assert.isFalse(result.stopped)
        assert.match(result.message, /waiting/)
        assert.deepStrictEqual(yield* starts.waiting, [b, c])

        return
      }

      if (mode === "failed-close") {
        const gate = yield* (yield* FakeRuntime).hold("close", id)
        const stop = yield* Effect.forkChild(Effect.exit(sessions.stop(id, { type: "user" })))
        yield* gate.reached
        yield* gate.release("failed")
        assert.equal((yield* Fiber.join(stop))._tag, "Failure")
        assert.deepStrictEqual(yield* starts.waiting, [b, c])
        assert.isNull((yield* sessionStore.getSession(id))!.process!.endedAt)

        return
      }

      if (mode === "direct") assert.isTrue((yield* sessions.stop(id, { type: "user" })).stopped)
      else {
        yield* TestClock.adjust("31 minutes")
        yield* (yield* PluginHost).load([idleStop])
      }

      yield* until(sessionStore.getSession(b), (r) => !!r?.process?.placedAt || r?.process?.placedAt === 0)
      assert.deepStrictEqual(yield* starts.waiting, [c])
      const sql = yield* SqlClient.SqlClient
      const count = yield* sql<{ n: number }>`SELECT count(*) AS n FROM process WHERE ended_at IS NULL`
      assert.equal(count[0]!.n, 2)
      yield* sessions.send(id, "resume A")
      yield* until(starts.waiting, (ids) => ids.join() === [c, id].join())
      const alreadyWaiting = yield* sessions.stop(id, { type: "user" })
      assert.isFalse(alreadyWaiting.stopped)
      assert.deepStrictEqual(yield* starts.waiting, [c, id])
    }),
    { hooked: ["pi", "pulling-pi", "claude"] },
  )
