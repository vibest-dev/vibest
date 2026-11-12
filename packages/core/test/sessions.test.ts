import { assert, describe } from "@effect/vitest"
import { SessionLive } from "@vibest/core/session/live"
import { Sessions } from "@vibest/core/sessions"
import { Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"

import { FakeRuntime } from "./lib/fake-runtime.ts"
import { atMostEntryTracked, replyOf, settleEntry, settled, until, untilVirtual, writeEnd } from "./lib/observe.ts"
import { makeRepository } from "./lib/session.ts"
import { entryOfProject, spawnInput, spawnWorking, test, sqlNotices } from "./lib/sessions-helpers.ts"

describe.concurrent("Sessions", () => {
  test(
    "a session's in-memory flags, lock and live status go once it ends; resumed, its next execution ends as any execution does; archived, they go again with no check of its own",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, sessions, db, entryId } = yield* spawnWorking(yield* makeRepository)
      yield* settleEntry(sessions, entryId)
      const entryStatuses = (yield* (yield* SessionLive).size).statuses - 1
      assert.deepInclude(yield* sessions.inMemory, { tracked: 2, locks: 0 })
      assert.strictEqual((yield* (yield* SessionLive).size).statuses, entryStatuses + 1)
      yield* herdr.updateAgent(id, (a) => ({ ...a, alive: false }))
      yield* Effect.all([sessions.check(id), sessions.check(id), sessions.check(id)], { concurrency: "unbounded" })
      yield* settled
      assert.deepInclude(yield* db.getSession(id), { executionState: "failed" })
      assert.strictEqual((yield* (yield* SessionLive).size).statuses, entryStatuses)
      yield* until(sessions.inMemory, atMostEntryTracked)
      yield* sessions.send(id, "next")
      yield* until(herdr.callsTo("send"), (calls) => calls.some((c) => c.text === "next"))
      yield* sessions.check(id)
      assert.deepInclude(yield* db.getSession(id), { executionState: "open", exitedAt: null })
      yield* writeEnd(id, "pi", { text: "done again" })
      yield* herdr.endExecution(id)
      yield* sessions.check(id)
      assert.deepInclude(yield* db.getSession(id), { executionState: "completed" })
      assert.include(yield* replyOf(id), "done again")
      yield* TestClock.adjust("10 seconds")
      assert.strictEqual((yield* sessions.inMemory).tracked, 2)
      assert.deepInclude(yield* db.getSession(id), { status: "idle" })
      yield* sessions.remove(id)
      assert.strictEqual((yield* (yield* SessionLive).size).statuses, entryStatuses)
      yield* untilVirtual(sessions.inMemory, atMostEntryTracked)
    }),
    { hooked: ["pi"] },
  )

  test(
    "a delivery waiting on the exit does not resume once that exit has failed the queued send",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository)
      const opens = () => Effect.map(herdr.callsTo("open"), (calls) => calls.length)
      const before = yield* opens()
      const stateHeld = yield* herdr.hold("state", id)
      yield* herdr.updateAgent(id, (a) => ({ ...a, alive: false }))
      const checking = yield* Effect.forkChild(sessions.check(id))
      yield* stateHeld.reached
      const processHeld = yield* herdr.hold("process", id)
      yield* stateHeld.release()
      yield* processHeld.reached
      yield* sessions.send(id, "queued")
      for (let i = 0; i < 30; i++) yield* Effect.yieldNow
      assert.lengthOf(yield* db.pendingInbox(id), 1)
      yield* processHeld.release()
      yield* Fiber.join(checking)
      for (let i = 0; i < 30; i++) yield* Effect.yieldNow
      yield* settled
      assert.deepInclude(yield* db.getSession(id), { executionState: "failed" })
      assert.isNotNull((yield* db.getSession(id))!.exitedAt)
      assert.lengthOf(yield* db.pendingInbox(id), 0)
      assert.lengthOf(yield* db.inboxWithStatus(id, "failed"), 1)
      assert.strictEqual(yield* opens(), before)
      const notices = yield* sqlNotices(id)
      assert.lengthOf(notices, 1)
      assert.include(notices[0], "exited during an execution")
      assert.include(notices[0], "Not delivered:\n\nqueued")
    }),
  )

  test(
    "spawn without a harness and nothing to inherit is NoHarnessChosen",
    Effect.gen(function* () {
      const repo = yield* makeRepository
      const { parentSessionId: _, ...input } = yield* spawnInput(repo)
      const error = yield* Effect.flip(
        (yield* Sessions).spawn({
          ...input,
          harness: undefined,
          origin: { peer: "a".repeat(32), project: "p", reportTo: "origin-session" },
        }),
      )
      assert.strictEqual(error._tag, "NoHarnessChosen")
      assert.include(error.message, "no harness to inherit")
      assert.include(error.message, "this machine can run: ")
    }),
  )

  test(
    "an inherited harness that cannot run here fails naming whose it was, and lists the harnesses this machine can run",
    Effect.gen(function* () {
      const repo = yield* makeRepository
      const parent = yield* entryOfProject(repo)
      const error = yield* Effect.flip((yield* Sessions).spawn({ ...(yield* spawnInput(repo)), harness: undefined }))
      assert.strictEqual(error._tag, "HarnessUnavailable")
      assert.include(error.message, `(inherited from ${parent})`)
      assert.match(error.message, /this machine can run: .*claude/)
      assert.notMatch(error.message, /can run: .*\bpi\b/)
    }),
    { unusable: ["pi"] },
  )
})
