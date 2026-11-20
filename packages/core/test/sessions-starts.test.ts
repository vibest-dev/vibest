import { assert, describe } from "@effect/vitest"
import { Concurrency } from "@vibest/core/concurrency"
import { Db } from "@vibest/core/database/db"
import { executionStateOf, exitedAt } from "@vibest/core/database/db-rows"
import { Session } from "@vibest/core/session"
import { Starts } from "@vibest/core/session/starts"
import { Effect, Ref } from "effect"

import { FakeRuntime } from "./lib/fake-runtime.ts"
import { settled, until, writeEnd } from "./lib/observe.ts"
import { makeRepository } from "./lib/session.ts"
import { entryOfProject, spawnInput, spawnWorking, test } from "./lib/sessions-helpers.ts"

const limitTo = (rules: ReadonlyArray<{ readonly max: number }> | undefined) =>
  Effect.flatMap(Concurrency.Service, (c) => c.configure(rules))

const placed = (id: string) =>
  Effect.map(Db.Service, (db) => db.session.getSession(id)).pipe(
    Effect.flatten,
    Effect.map((row) => (row?.process?.placedAt ?? null) !== null),
  )

const waiting = Effect.flatMap(Starts.Service, (starts) => starts.waiting)

const spawnSome = (repo: string, n: number) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const input = yield* spawnInput(repo)

    return yield* Effect.forEach(
      Array.from({ length: n }, (_, i) => i),
      (i) => Effect.map(sessions.spawn({ ...input, name: `task ${i}` }), (spawned) => spawned.id),
      { concurrency: "unbounded" },
    )
  })

const exit = (id: string) =>
  Effect.gen(function* () {
    yield* (yield* FakeRuntime).updateAgent(id, (agent) => ({ ...agent, alive: false }))
    yield* (yield* Session.Service).check(id)
  })

describe("a cap on live harness processes", () => {
  test(
    "concurrent starts never pass the cap, and a waiting start launches when a process ends",
    Effect.gen(function* () {
      const repo = yield* makeRepository
      yield* entryOfProject(repo)
      yield* limitTo([{ max: 2 }])
      const ids = yield* spawnSome(repo, 3)
      yield* until(waiting, (keys) => keys.length === 2)
      yield* settled
      const live = yield* Effect.filter(ids, placed)
      assert.lengthOf(live, 1)

      yield* exit(live[0]!)
      yield* until(Effect.filter(ids, placed), (now) => now.length === 2)
      assert.lengthOf(yield* waiting, 1)
    }),
  )

  test(
    "raising or removing the limit launches the waiting starts",
    Effect.gen(function* () {
      const repo = yield* makeRepository
      yield* entryOfProject(repo)
      yield* limitTo([{ max: 1 }])
      const ids = yield* spawnSome(repo, 3)
      yield* until(waiting, (keys) => keys.length === 3)

      yield* limitTo([{ max: 2 }])
      yield* until(Effect.filter(ids, placed), (now) => now.length === 1)
      assert.lengthOf(yield* waiting, 2)

      yield* limitTo(undefined)
      yield* until(Effect.filter(ids, placed), (now) => now.length === 3)
      assert.lengthOf(yield* waiting, 0)
    }),
  )

  test(
    "a start that never becomes ready holds its process place but not the queue, and a failed start frees its place",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const db = yield* Db.Service
      const sessions = yield* Session.Service
      const repo = yield* makeRepository
      yield* entryOfProject(repo)
      yield* limitTo([{ max: 3 }])
      yield* Ref.set(herdr.onStarted, () => Effect.void)
      const [never] = yield* spawnSome(repo, 1)
      yield* until(placed(never!), (yes) => yes)

      const opening = yield* herdr.hold("open")
      const { id: failing } = yield* sessions.spawn({ ...(yield* spawnInput(repo)), name: "failing" })
      yield* opening.reached
      const [next] = yield* spawnSome(repo, 1)
      assert.deepStrictEqual(yield* waiting, [next])

      yield* opening.release("failed")
      yield* until(db.session.getSession(failing), (row) => row !== undefined && exitedAt(row) !== null)
      yield* until(placed(next!), (yes) => yes)
    }),
  )

  test(
    "a running session takes sends while the cap is full",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository)
      yield* limitTo([{ max: 1 }])
      yield* sessions.send(id, "while full")
      yield* writeEnd(id, "pi", { text: "status: completed" })
      yield* herdr.endExecution(id)
      yield* sessions.check(id)
      yield* until(db.inbox.pendingInbox(id), (rows) => rows.length === 0)
      assert.strictEqual(executionStateOf((yield* db.session.getSession(id))!), "open")
      assert.strictEqual((yield* herdr.callsTo("send")).at(-1)!.text, "while full")
    }),
  )
})
