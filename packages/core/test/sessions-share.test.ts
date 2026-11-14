import { assert, describe } from "@effect/vitest"
import { Db } from "@vibest/core/database/db"
import { terminalOf, exitedAt } from "@vibest/core/database/db-rows"
import { Integration } from "@vibest/core/integration"
import { Deferred, Effect, Fiber, FileSystem, HashMap } from "effect"
import { TestClock } from "effect/testing"

import { FakeProcesses } from "./lib/fake-processes.ts"
import { FakeRuntime } from "./lib/fake-runtime.ts"
import { until } from "./lib/observe.ts"
import { makeRepository, type TestOptions } from "./lib/session.ts"
import { spawnInput, idleSession, sessionWorktree, test } from "./lib/sessions-helpers.ts"

describe.concurrent("Session", () => {
  const sharersOfDirectory = (ownerId: string) =>
    Effect.gen(function* () {
      const db = yield* Db.Service
      const shared = yield* db.session.sessionDirectory(ownerId)
      return yield* Effect.filter(
        (yield* db.session.listSessions({ stopped: true })).filter((s) => s.id !== ownerId),
        (s) => db.session.sessionDirectory(s.id).pipe(Effect.map((d) => d === shared)),
      )
    })

  const parkedInsert = () => {
    const reached = Deferred.makeUnsafe<void>()
    const go = Deferred.makeUnsafe<void>()
    const state = { armed: false }
    const options: TestOptions = {
      db: (db) => ({
        ...db,
        session: {
          ...db.session,
          insertSession: (...args) =>
            state.armed
              ? Deferred.succeed(reached, undefined).pipe(
                  Effect.andThen(Deferred.await(go)),
                  Effect.andThen(db.session.insertSession(...args)),
                )
              : db.session.insertSession(...args),
        },
      }),
    }
    return {
      options,
      arm: Effect.sync(() => {
        state.armed = true
      }),
      reached: Deferred.await(reached),
      release: Deferred.succeed(go, undefined).pipe(Effect.asVoid),
    }
  }

  const parked = parkedInsert()

  test(
    "owner archive cannot delete a clean worktree while run --share is admitted",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const herdr = yield* FakeRuntime
      const processes = yield* FakeProcesses
      const repo = yield* makeRepository
      const owner = yield* idleSession(repo)
      const worktree = yield* sessionWorktree(owner.id)
      yield* parked.arm
      const cwd = yield* processes.holdCwd()
      const split = yield* herdr.hold("open")
      const reset = Effect.all([cwd.release(), split.release(), parked.release], { discard: true }).pipe(Effect.ignore)
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
    parked.options,
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
        owner.db.session.getSession((yield* sharersOfDirectory(owner.id))[0]!.id),
        (w) => !!w && ((w.process?.placedAt ?? null) !== null || exitedAt(w) !== null),
      )
    }),
  )

  const parkedBehindShare = parkedInsert()

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
      yield* until(
        owner.db.session.getSession(mid.id),
        (w) => !!w && ((w.process?.placedAt ?? null) !== null || exitedAt(w) !== null),
      )
      const midPane = (yield* herdr.agent(mid.id))!.terminal
      yield* herdr.runtime.close({ id: midPane })
      yield* owner.db.session.endProcess(mid.id, "exited")
      yield* owner.db.session.setStatus(mid.id, "unknown")
      yield* parkedBehindShare.arm
      const cwd = yield* processes.holdCwd()
      const split = yield* herdr.hold("open")
      const reset = Effect.all([cwd.release(), split.release(), parkedBehindShare.release], { discard: true }).pipe(
        Effect.ignore,
      )
      yield* Effect.gen(function* () {
        const spawning = yield* Effect.forkChild(owner.sessions.spawn({ ...(yield* spawnInput(repo)), share: mid.id }))
        yield* parkedBehindShare.reached
        const archiving = yield* Effect.forkChild(owner.sessions.remove(owner.id))
        const listed = yield* Effect.race(
          cwd.reached.pipe(Effect.as(true)),
          TestClock.withLive(Effect.sleep("2 seconds")).pipe(Effect.as(false)),
        )
        if (listed) {
          yield* parkedBehindShare.release
          yield* until(sharersOfDirectory(owner.id), (rows) =>
            rows.some((s) => s.id !== mid.id && exitedAt(s) === null),
          )
          yield* cwd.release()
          const archived = (yield* Fiber.join(archiving))!
          assert.fail(
            "owner archive listed before share-of-share insert and removed the tree: worktree=" + archived.worktree,
          )
        }
        yield* parkedBehindShare.release
        yield* until(sharersOfDirectory(owner.id), (rows) => rows.some((s) => s.id !== mid.id))
        yield* cwd.release()
        const archived = (yield* Fiber.join(archiving))!
        assert.strictEqual(archived.worktree, "kept")
        assert.isTrue(yield* fs.exists(worktree))
        yield* split.release()
        yield* Fiber.join(spawning)
      }).pipe(Effect.ensuring(reset))
    }),
    parkedBehindShare.options,
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
      yield* until(owner.db.session.getSession(id), (w) => !!w && exitedAt(w) !== null)
      const newCloses = (yield* herdr.callsTo("close"))
        .map((c) => c.terminal)
        .filter((pane) => !closesBefore.includes(pane))
      assert.deepStrictEqual(newCloses, [])
      assert.isTrue(HashMap.has(yield* herdr.panes, ownerPane))
      assert.isTrue(yield* fs.exists(worktree))
      assert.strictEqual((yield* herdr.callsTo("open")).length, created + 1)
      assert.strictEqual(
        yield* owner.db.session.sessionDirectory(id),
        yield* owner.db.session.sessionDirectory(owner.id),
      )
      yield* owner.sessions.send(id, "start again")
      const opens = yield* until(herdr.callsTo("open"), (calls) => calls.length === created + 2)
      const reporter = Number(opens.at(-1)!.env.VIBEST_PROCESS)
      yield* until(
        owner.db.session.getSession(id),
        (w) => w !== undefined && exitedAt(w) === null && terminalOf(w).id !== "",
      )
      assert.strictEqual(yield* owner.db.session.currentProcessId(id), reporter)
      assert.strictEqual(yield* (yield* Integration.Service).ready(id, 4242, undefined, reporter), reporter)
    }),
  )
})
