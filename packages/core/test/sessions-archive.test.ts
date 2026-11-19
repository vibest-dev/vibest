import { assert, describe } from "@effect/vitest"
import { exitedAt } from "@vibest/core/database/db-rows"
import { Effect, FileSystem } from "effect"

import { until } from "./lib/observe.ts"
import { makeRepository } from "./lib/session.ts"
import { spawnInput, idleSession, sessionWorktree, test } from "./lib/sessions-helpers.ts"

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
        (yield* owner.sessions.remove(owner.id, { keepWorktree: true }))!.reasons.join("\n"),
        "--keep-worktree",
      )
      const out = (yield* owner.sessions.remove(id))!
      assert.strictEqual(out.worktree, "removed")
      assert.isFalse(yield* fs.exists(worktree))
    }),
  )
})
