import { assert, describe } from "@effect/vitest"
import { Db } from "@vibest/core/db"
import { Integration } from "@vibest/core/integration"
import { shareAdmitPause } from "@vibest/core/sessions"
import { Deferred, Effect, Fiber, FileSystem, HashMap } from "effect"
import { TestClock } from "effect/testing"

import { FakeProcesses } from "./lib/fake-processes.ts"
import { FakeRuntime } from "./lib/fake-runtime.ts"
import { until } from "./lib/observe.ts"
import { makeRepository } from "./lib/session.ts"
import { spawnInput, idleSession, sessionWorktree, test } from "./lib/sessions-helpers.ts"

describe.concurrent("Sessions", () => {
  const sharersOfDirectory = (ownerId: string) =>
    Effect.gen(function* () {
      const db = yield* Db
      const shared = yield* db.sessionDirectory(ownerId)
      return yield* Effect.filter(
        (yield* db.listSessions({ stopped: true })).filter((s) => s.id !== ownerId),
        (s) => db.sessionDirectory(s.id).pipe(Effect.map((d) => d === shared)),
      )
    })

  const parkAdmitBeforeInsert = Effect.gen(function* () {
    const reached = yield* Deferred.make<void>()
    const go = yield* Deferred.make<void>()
    shareAdmitPause.wait = Deferred.succeed(reached, undefined).pipe(Effect.andThen(Deferred.await(go)))
    return { reached: Deferred.await(reached), release: Deferred.succeed(go, undefined).pipe(Effect.asVoid) }
  })

  test(
    "owner archive cannot delete a clean worktree while run --share is admitted",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const herdr = yield* FakeRuntime
      const processes = yield* FakeProcesses
      const repo = yield* makeRepository
      const owner = yield* idleSession(repo)
      const worktree = yield* sessionWorktree(owner.id)
      const parked = yield* parkAdmitBeforeInsert
      const cwd = yield* processes.holdCwd()
      const split = yield* herdr.hold("open")
      const reset = Effect.sync(() => {
        shareAdmitPause.wait = Effect.void
      }).pipe(
        Effect.andThen(
          Effect.all([cwd.release(), split.release(), parked.release], { discard: true }).pipe(Effect.ignore),
        ),
      )
      yield* Effect.gen(function* () {
        const spawning = yield* Effect.forkChild(
          owner.sessions.spawn({ ...(yield* spawnInput(repo)), share: owner.id }),
        )
        yield* parked.reached
        const archiving = yield* Effect.forkChild(owner.sessions.remove(owner.id))
        const listed = yield* Effect.race(
          cwd.reached.pipe(Effect.as(true)),
          TestClock.withLive(Effect.sleep("2 seconds")).pipe(Effect.as(false)),
        )
        if (listed) {
          yield* parked.release
          yield* until(sharersOfDirectory(owner.id), (rows) => rows.length === 1)
          yield* cwd.release()
          const archived = (yield* Fiber.join(archiving))!
          const exists = yield* fs.exists(worktree)
          assert.fail(
            "archive listed no borrower then removed the tree after admit: worktree=" +
              archived.worktree +
              " exists=" +
              String(exists),
          )
        }
        assert.deepStrictEqual(yield* sharersOfDirectory(owner.id), [])
        assert.isUndefined(archiving.pollUnsafe())
        yield* parked.release
        yield* until(sharersOfDirectory(owner.id), (rows) => rows.length === 1)
        yield* cwd.release()
        const archived = (yield* Fiber.join(archiving))!
        assert.strictEqual(archived.worktree, "kept")
        assert.include(archived.reasons.join("\n"), (yield* sharersOfDirectory(owner.id))[0]!.id)
        assert.isTrue(yield* fs.exists(worktree))
        yield* split.release()
        yield* Fiber.join(spawning)
      }).pipe(Effect.ensuring(reset))
    }),
    undefined,
    true,
  )

  test(
    "a borrower admitted before archive keeps the clean worktree while its launch is still in herdr",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const herdr = yield* FakeRuntime
      const repo = yield* makeRepository
      const owner = yield* idleSession(repo)
      const worktree = yield* sessionWorktree(owner.id)
      const split = yield* herdr.hold("open")
      yield* Effect.gen(function* () {
        const spawning = yield* Effect.forkChild(
          owner.sessions.spawn({ ...(yield* spawnInput(repo)), share: owner.id }),
        )
        yield* split.reached
        const admitted = yield* Fiber.join(spawning)
        const archiving = yield* Effect.forkChild(owner.sessions.remove(owner.id))
        yield* until(
          Effect.sync(() => archiving.pollUnsafe()),
          (exit) => exit !== undefined,
        )
        const archived = (yield* Fiber.join(archiving))!
        assert.strictEqual(archived.worktree, "kept")
        assert.include(archived.reasons.join("\n"), admitted.id)
        assert.isTrue(yield* fs.exists(worktree))
      }).pipe(Effect.ensuring(split.release().pipe(Effect.ignore)))
      yield* until(
        owner.db.getSession((yield* sharersOfDirectory(owner.id))[0]!.id),
        (w) => !!w && (w.startedAt !== null || w.exitedAt !== null),
      )
    }),
  )

  test(
    "run --share of an exited session takes the directory's lock, so another archive cannot delete the shared tree",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const herdr = yield* FakeRuntime
      const processes = yield* FakeProcesses
      const repo = yield* makeRepository
      const owner = yield* idleSession(repo)
      const worktree = yield* sessionWorktree(owner.id)
      const mid = yield* owner.sessions.spawn({ ...(yield* spawnInput(repo)), share: owner.id })
      yield* until(owner.db.getSession(mid.id), (w) => !!w && (w.startedAt !== null || w.exitedAt !== null))
      const midPane = (yield* herdr.agent(mid.id))!.terminal
      yield* herdr.runtime.close({ id: midPane })
      yield* owner.db.updateSession(mid.id, { status: "unknown", exitedAt: 1 })
      const parked = yield* parkAdmitBeforeInsert
      const cwd = yield* processes.holdCwd()
      const split = yield* herdr.hold("open")
      const reset = Effect.sync(() => {
        shareAdmitPause.wait = Effect.void
      }).pipe(
        Effect.andThen(
          Effect.all([cwd.release(), split.release(), parked.release], { discard: true }).pipe(Effect.ignore),
        ),
      )
      yield* Effect.gen(function* () {
        const spawning = yield* Effect.forkChild(owner.sessions.spawn({ ...(yield* spawnInput(repo)), share: mid.id }))
        yield* parked.reached
        const archiving = yield* Effect.forkChild(owner.sessions.remove(owner.id))
        const listed = yield* Effect.race(
          cwd.reached.pipe(Effect.as(true)),
          TestClock.withLive(Effect.sleep("2 seconds")).pipe(Effect.as(false)),
        )
        if (listed) {
          yield* parked.release
          yield* until(sharersOfDirectory(owner.id), (rows) => rows.some((s) => s.id !== mid.id && s.exitedAt === null))
          yield* cwd.release()
          const archived = (yield* Fiber.join(archiving))!
          assert.fail(
            "owner archive listed before share-of-share insert and removed the tree: worktree=" + archived.worktree,
          )
        }
        yield* parked.release
        yield* until(sharersOfDirectory(owner.id), (rows) => rows.some((s) => s.id !== mid.id))
        yield* cwd.release()
        const archived = (yield* Fiber.join(archiving))!
        assert.strictEqual(archived.worktree, "kept")
        assert.isTrue(yield* fs.exists(worktree))
        yield* split.release()
        yield* Fiber.join(spawning)
      }).pipe(Effect.ensuring(reset))
    }),
    undefined,
    true,
  )

  test(
    "a failed share launch closes only the new split pane and leaves the owner's pane and worktree",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const herdr = yield* FakeRuntime
      const repo = yield* makeRepository
      const owner = yield* idleSession(repo)
      const worktree = yield* sessionWorktree(owner.id)
      const ownerPane = (yield* herdr.agent(owner.id))!.terminal
      const closesBefore = (yield* herdr.callsTo("close")).map((c) => c.terminal)
      const created = (yield* herdr.callsTo("open")).length
      const held = yield* herdr.hold("open")
      const { id } = yield* owner.sessions.spawn({ ...(yield* spawnInput(repo, "claude")), share: owner.id })
      yield* held.reached
      yield* held.release("failed")
      yield* until(owner.db.getSession(id), (w) => !!w && w.exitedAt !== null)
      const newCloses = (yield* herdr.callsTo("close"))
        .map((c) => c.terminal)
        .filter((pane) => !closesBefore.includes(pane))
      assert.deepStrictEqual(newCloses, [])
      assert.isTrue(HashMap.has(yield* herdr.panes, ownerPane))
      assert.isTrue(yield* fs.exists(worktree))
      assert.strictEqual((yield* herdr.callsTo("open")).length, created + 1)
      assert.strictEqual(yield* owner.db.sessionDirectory(id), yield* owner.db.sessionDirectory(owner.id))
      yield* owner.sessions.send(id, "start again")
      const opens = yield* until(herdr.callsTo("open"), (calls) => calls.length === created + 2)
      const reporter = Number(opens.at(-1)!.env.VIBEST_PROCESS)
      yield* until(owner.db.getSession(id), (w) => w?.exitedAt === null && w.address.id !== "")
      assert.strictEqual(yield* owner.db.currentProcessId(id), reporter)
      assert.strictEqual(yield* (yield* Integration).ready(id, 4242, undefined, reporter), reporter)
    }),
  )
})
