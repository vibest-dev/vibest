import { assert, describe } from "@effect/vitest"
import { Db } from "@vibest/core/database/db"
import { terminalOf } from "@vibest/core/database/db-rows"
import { Session } from "@vibest/core/session"
import { Deferred, Effect, FileSystem } from "effect"

import { KIND as RUNTIME } from "../../runtime-herdr/src/terminal-runtime.ts"
import { projectOf } from "./lib/directory.ts"
import { FakeProcesses } from "./lib/fake-processes.ts"
import { FakeRuntime } from "./lib/fake-runtime.ts"
import { CLAUDE, CURSOR, PI } from "./lib/harnesses.ts"
import { until, processEnds } from "./lib/observe.ts"
import { makeRepository, restartSessions, type TestServices } from "./lib/session.ts"
import { idleSession, sessionWorktree, spawnInput, sqlNotices, test } from "./lib/sessions-helpers.ts"

const nextVibestd = (done: Effect.Effect<boolean, never, TestServices>) =>
  Effect.gen(function* () {
    const next = yield* restartSessions
    yield* until(done, (yes) => yes)
    yield* until(next.inMemory, (m) => m.locks === 0)
  })

const heldAtOpen = <A, E, R, R2>(
  target: string | undefined,
  start: Effect.Effect<unknown, never, R2>,
  body: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const held = yield* (yield* FakeRuntime).hold("open", target)
    yield* start
    yield* held.reached

    return yield* body.pipe(Effect.ensuring(held.release("unreachable")))
  })

describe.concurrent("after a vibestd stop", () => {
  const cutOffSpawn = <A, E, R>(body: (id: string) => Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const db = yield* Db.Service
      const repo = yield* makeRepository
      yield* db.session.startEntry(
        yield* projectOf(repo),
        "pi",
        false,
        {
          runtime: RUNTIME,
          address: { machine: "local", id: "test/coord" },
        },
        { agent: "coordinator" },
      )
      const spawned = yield* Deferred.make<string>()

      return yield* heldAtOpen(
        undefined,
        Effect.flatMap(Session.Service, (sessions) =>
          spawnInput(repo).pipe(
            Effect.flatMap(sessions.spawn),
            Effect.flatMap(({ id }) => Deferred.succeed(spawned, id)),
            Effect.orDie,
          ),
        ),
        Effect.flatMap(Deferred.await(spawned), body),
      )
    })

  test(
    "a spawn cut off before its terminal ends launch_failed, its worktree removed, with one notice",
    cutOffSpawn((id) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const db = yield* Db.Service
        const worktree = yield* sessionWorktree(id)
        assert.isTrue(yield* fs.exists(worktree))
        yield* nextVibestd(Effect.map(sqlNotices(id), (n) => n.length > 0))
        assert.deepStrictEqual(yield* processEnds(id), ["launch_failed"])
        assert.isFalse(yield* fs.exists(worktree))
        const notices = yield* sqlNotices(id)
        assert.strictEqual(notices.length, 1)
        assert.include(
          notices[0],
          `${id.slice(0, 8)} (task) never finished starting (vibestd stopped while it started); its worktree was removed.`,
        )
        const row = (yield* db.session.getSession(id))!
        assert.isNull(row.process?.placedAt ?? null)
        assert.strictEqual(row.status, "unknown")
      }),
    ),
  )

  test(
    "a spawn cut off before its terminal keeps its worktree while a process works in it, and names it",
    cutOffSpawn((id) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        yield* (yield* FakeProcesses).setCwdUsers([4242])
        yield* nextVibestd(Effect.map(sqlNotices(id), (n) => n.length > 0))
        assert.deepStrictEqual(yield* processEnds(id), ["launch_failed"])
        assert.isTrue(yield* fs.exists(yield* sessionWorktree(id)))
        const [text] = yield* sqlNotices(id)
        assert.include(text!, "never finished starting (vibestd stopped while it started)")
        assert.include(text!, "process 4242 has its working directory in it")
      }),
    ),
  )

  test(
    "a resume cut off before its terminal falls back to its previous start and keeps its worktree",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const herdr = yield* FakeRuntime
      const { id, sessions, db } = yield* idleSession(yield* makeRepository)
      const before = (yield* db.session.getSession(id))!
      yield* herdr.updateAgent(id, (a) => ({ ...a, alive: false }))
      yield* sessions.check(id)
      yield* heldAtOpen(
        id,
        sessions.send(id, "next").pipe(Effect.orDie),
        Effect.gen(function* () {
          assert.isNull((yield* db.session.getSession(id))!.process?.placedAt ?? null)
          const cutOff = (texts: ReadonlyArray<string>) => texts.find((t) => t.includes("never finished starting"))
          yield* nextVibestd(Effect.map(sqlNotices(id), (n) => cutOff(n) !== undefined))
          assert.deepStrictEqual(yield* processEnds(id), ["exited", "launch_failed"])
          const after = (yield* db.session.getSession(id))!
          assert.deepStrictEqual(
            [terminalOf(after), after.process?.placedAt ?? null],
            [terminalOf(before), before.process?.placedAt ?? null],
          )
          assert.isTrue(yield* fs.exists(yield* sessionWorktree(id)))
          assert.match(
            cutOff(yield* sqlNotices(id))!,
            /never finished starting \(vibestd stopped while it started\)\.$/,
          )
        }),
      )
    }),
    { hooked: ["pi"], harnesses: [{ ...PI, delivery: "pull" }, CLAUDE, CURSOR] },
  )
})
