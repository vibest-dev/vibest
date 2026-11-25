import { assert, describe } from "@effect/vitest"
import { exitedAt } from "@vibest/core/database/db-rows"
import { Runtimes } from "@vibest/core/runtimes"
import { Exits } from "@vibest/core/session/exits"
import { FakeRuntime } from "@vibest/testkit/fake-runtime"
import { settled, until } from "@vibest/testkit/observe"
import { makeRepository } from "@vibest/testkit/session"
import {
  idleSession,
  sessionWorktree,
  spawnInput,
  spawnWorking,
  sqlNotices,
  test,
} from "@vibest/testkit/sessions-helpers"
import { Effect, FileSystem } from "effect"

import { KIND as RUNTIME } from "../../runtime-herdr/src/terminal-runtime.ts"

describe.concurrent("an exited session", () => {
  const exitedSession = Effect.gen(function* () {
    const herdr = yield* FakeRuntime
    const w = yield* idleSession(yield* makeRepository)
    yield* herdr.updateAgent(w.id, (a) => ({ ...a, alive: false }))
    yield* w.sessions.check(w.id)
    yield* until(w.db.session.getSession(w.id), (row) => (row ? exitedAt(row) : null) !== null)
    yield* settled

    return { ...w, herdr }
  })

  test(
    "archive leaves its pane open, and says so, when another live session now runs at that terminal",
    Effect.gen(function* () {
      const w = yield* exitedSession
      const target = w.row.process!.terminal!
      yield* w.db.session.startRoot(
        w.row.projectId,
        "claude",
        false,
        { runtime: RUNTIME, target },
        { agent: "general" },
      )
      const [other] = yield* w.db.session.processesAt(RUNTIME, target)
      const out = (yield* w.sessions.archive(w.id))!
      assert.deepStrictEqual(yield* w.herdr.callsTo("close"), [])
      assert.include(out.reasons.join("\n"), `left open: session ${other!.sessionId} runs in it`)
    }),
  )

  test(
    "its exit notice shows at most the last 10 lines of its terminal, each cut to 200 characters, 2000 in all",
    Effect.gen(function* () {
      const w = yield* spawnWorking(yield* makeRepository)
      const runtime = yield* (yield* Runtimes.Service).route(RUNTIME)
      const exits = yield* Exits.make
      const screen = Array.from({ length: 40 }, (_, i) => `line${i}`.padEnd(65_536, "x")).join("\n")
      yield* exits.settle({ ...runtime, read: () => Effect.succeed(screen) }, w.id, w.row.process!.id)
      const [notice] = yield* sqlNotices(w.id)
      const shown = notice!.slice(notice!.indexOf("Its terminal shows:"))
      assert.include(shown, "line30")
      assert.notInclude(shown, "line29")
      assert.isAtMost(Math.max(...shown.split("\n").map((line) => line.length)), 200)
      assert.isAtMost(shown.length, 2000 + "Its terminal shows:\n\n".length)
    }),
  )
})

describe.concurrent("vibest archive", () => {
  test(
    "run --share: --keep-worktree keeps the directory at that archive only; the last session's archive removes it",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const repo = yield* makeRepository
      const owner = yield* idleSession(repo)
      const { id } = yield* owner.sessions.spawn({ ...(yield* spawnInput(repo)), share: owner.id })
      yield* until(
        owner.db.session.getSession(id),
        (w) => !!w && ((w.process?.placedAt ?? null) !== null || exitedAt(w) !== null),
      )
      const worktree = yield* sessionWorktree(owner.id)
      assert.include(
        (yield* owner.sessions.archive(owner.id, { keepWorktree: true }))!.reasons.join("\n"),
        "--keep-worktree",
      )
      const out = (yield* owner.sessions.archive(id))!
      assert.strictEqual(out.worktree, "removed")
      assert.isFalse(yield* fs.exists(worktree))
    }),
  )
})
