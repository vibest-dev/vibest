import { assert, describe, it } from "@effect/vitest"
import { Db, type NewSession } from "@vibest/core/db"
import type { HarnessId } from "@vibest/core/harness"
import { Layout, sameWorktreeBucket } from "@vibest/core/paths"
import { allocationNameSource, Sessions } from "@vibest/core/sessions"
import { repositoryDirectoryName } from "@vibest/core/worktree"
import { Effect, FileSystem, Path, type Scope } from "effect"

import { KIND as RUNTIME } from "../../runtime-herdr/src/terminal-runtime.ts"
import { projectOf } from "./lib/directory.ts"
import { FakeGit } from "./lib/fake-git.ts"
import { FakeRuntime } from "./lib/fake-runtime.ts"
import { until } from "./lib/observe.ts"
import { makeRepository, testLayer, type TestServices } from "./lib/session.ts"

const spawnInput = (repo: string, harness: HarnessId = "pi") =>
  Effect.map(
    projectOf(repo),
    (projectId) =>
      ({
        machine: { id: "local" },
        root: repo,
        parentSessionId: "creator",
        projectId,
        name: "task",
        prompt: "do it",
        harness,
        runtime: "herdr",
      }) as const,
  )

const test = <E>(name: string, program: Effect.Effect<void, E, TestServices | Scope.Scope>) =>
  it.effect(name, () => program.pipe(Effect.provide(testLayer())))

const storedRow = (
  id: string,
  metadata: NewSession["metadata"],
  patch: Partial<Omit<NewSession, "projectId" | "id" | "metadata">> = {},
): Omit<NewSession, "projectId"> => ({
  id,
  agent: "general",
  name: "stored",
  harnessId: "pi",
  provider: null,
  model: null,
  harnessSessionId: null,
  runtime: RUNTIME,
  address: { machine: "local", id: "test/" },
  status: "idle",
  startedAt: 1,
  exitedAt: null,
  executionState: "none",
  executionPromptedAt: 0,
  metadata,
  createdAt: 1,
  lastActive: 1,
  ...patch,
})

const marker = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    yield* fs.makeDirectory(dir, { recursive: true })
    yield* fs.writeFileString(path.join(dir, "keep"), "keep\n")
  })

const directoryOf = (id: string) => Effect.flatMap(Db, (db) => db.sessionDirectory(id)).pipe(Effect.map((d) => d ?? ""))

describe("repository-grouped worktrees at worktrees/<repository name>/<4 hex>: a name is reserved by creating its directory, so whatever already sits at a path takes that name", () => {
  test(
    "a name whose directory or dangling symlink already exists is skipped and left untouched",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const layout = yield* Layout
      const db = yield* Db
      const sessions = yield* Sessions
      const repo = yield* makeRepository
      allocationNameSource.leaves = ["ab01", "ab02", "ab03"]
      const reset = Effect.ensuring(Effect.sync(() => (allocationNameSource.leaves = undefined)))
      const repository = yield* repositoryDirectoryName(repo)
      const taken = layout.allocationWorktree(repository, "ab01")
      yield* marker(taken)
      const link = layout.allocationWorktree(repository, "ab02")
      yield* fs.symlink("nowhere", link)
      const { id } = yield* sessions.spawn(yield* spawnInput(repo)).pipe(reset)
      assert.strictEqual(yield* directoryOf(id), layout.allocationWorktree(repository, "ab03"))
      yield* until(db.getSession(id), (w) => w?.startedAt !== null)
      assert.strictEqual(yield* fs.readFileString(path.join(taken, "keep")), "keep\n")
      assert.strictEqual(yield* fs.readLink(link), "nowhere")
    }),
  )

  test(
    "creation does not allocate inside an existing checkout at the repository name",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const layout = yield* Layout
      const herdr = yield* FakeRuntime
      const sessions = yield* Sessions
      const repo = yield* makeRepository
      const name = path.basename(repo)
      const parent = path.join(layout.worktrees, name)
      yield* fs.makeDirectory(layout.worktrees, { recursive: true })
      yield* (yield* FakeGit).git.addWorktree(repo, parent)
      yield* fs.writeFileString(path.join(parent, ".git"), "gitdir: elsewhere\n")
      const failed = yield* Effect.flip(sessions.spawn(yield* spawnInput(repo)))
      assert.strictEqual(failed._tag, "AllocationFailed")
      assert.include(failed.message, parent)
      assert.lengthOf(yield* herdr.callsTo("open"), 0)
      assert.isTrue(yield* fs.exists(path.join(parent, ".git")))
      assert.isTrue(yield* fs.exists(path.join(parent, "README.md")))
    }),
  )

  test(
    "a failed launch removes only the worktree it created",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const db = yield* Db
      const herdr = yield* FakeRuntime
      const repo = yield* makeRepository
      const held = yield* herdr.hold("open")
      const { id } = yield* (yield* Sessions).spawn(yield* spawnInput(repo))
      yield* held.reached
      const wt = yield* directoryOf(id)
      assert.isTrue(yield* fs.exists(wt))
      yield* fs.writeFileString(path.join(path.dirname(wt), "sibling"), "group\n")
      yield* held.release("failed")
      yield* until(db.getSession(id), (w) => !!w && w.exitedAt !== null)
      assert.isFalse(yield* fs.exists(wt))
      assert.strictEqual(yield* fs.readFileString(path.join(path.dirname(wt), "sibling")), "group\n")
    }),
  )

  test(
    "a directory outside worktrees, or none recorded, deletes nothing",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const layout = yield* Layout
      const db = yield* Db
      const sessions = yield* Sessions
      const repo = yield* makeRepository
      const key = yield* projectOf(repo)
      const outside = "e5f6a7b8-e5f6-4e5f-8e5f-e5f6a7b8e5f6"
      const none = "a7b8c9d0-a7b8-4a7b-8a7b-a7b8c9d0a7b8"
      const elsewhere = path.join(layout.home, "x", outside)
      yield* marker(elsewhere)
      yield* db.insertSession(storedRow(outside, {}), key, { cwd: elsewhere })
      yield* db.insertSession(storedRow(none, {}), key)
      const left = (yield* sessions.remove(outside))!
      assert.strictEqual(left.worktree, "kept")
      assert.include(left.reasons.join("\n"), "left alone")
      const empty = (yield* sessions.remove(none))!
      assert.strictEqual(empty.worktree, "kept")
      assert.strictEqual(empty.path, "")
      assert.include(empty.reasons.join("\n"), "nothing was deleted")
      assert.strictEqual(yield* fs.readFileString(path.join(elsewhere, "keep")), "keep\n")
    }),
  )

  test(
    "a held creation reserves its leaf, so the next draw does not alias it, even under a name differing only in case on a case-folding file system",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const sessions = yield* Sessions
      const db = yield* Db
      const layout = yield* Layout
      const herdr = yield* FakeRuntime
      const repo = yield* makeRepository
      const other = yield* makeRepository
      yield* (yield* FakeGit).update(repo, { origin: "git@github.com:Org/MyRepo.git" })
      yield* (yield* FakeGit).update(other, { origin: "git@github.com:Other/myrepo.git" })
      const reset = Effect.sync(() => (allocationNameSource.leaves = undefined))
      yield* Effect.gen(function* () {
        allocationNameSource.leaves = ["abcd", "abce"]
        const held = yield* herdr.hold("open")
        const first = yield* sessions.spawn(yield* spawnInput(repo))
        yield* held.reached
        assert.strictEqual(yield* directoryOf(first.id), layout.allocationWorktree("MyRepo", "abcd"))
        assert.isTrue(
          yield* fs.exists(layout.allocationWorktree("MyRepo", "abcd")),
          "the directory exists before the terminal opens",
        )
        allocationNameSource.leaves = ["abcd", "abce"]
        const second = yield* sessions.spawn(yield* spawnInput(other))
        yield* until(db.getSession(second.id), (w): w is NonNullable<typeof w> => w?.executionState === "open")
        const expected = sameWorktreeBucket("MyRepo", "myrepo") ? "abce" : "abcd"
        assert.strictEqual(yield* directoryOf(second.id), layout.allocationWorktree("myrepo", expected))
        yield* held.release()
        yield* until(db.getSession(first.id), (w): w is NonNullable<typeof w> => w?.executionState === "open")
        assert.strictEqual(yield* directoryOf(first.id), layout.allocationWorktree("MyRepo", "abcd"))
        assert.isTrue(yield* fs.exists(layout.allocationWorktree("MyRepo", "abcd")))
      }).pipe(Effect.ensuring(reset))
    }),
  )

  test(
    "exhausting the bounded name list, a directory and a file taking the names, opens nothing and inserts no row",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const herdr = yield* FakeRuntime
      const db = yield* Db
      const sessions = yield* Sessions
      const layout = yield* Layout
      const repo = yield* makeRepository
      yield* (yield* FakeGit).update(repo, { origin: "git@github.com:Org/MyRepo.git" })
      yield* marker(layout.allocationWorktree("MyRepo", "abcd"))
      const file = layout.allocationWorktree("MyRepo", "abce")
      yield* fs.writeFileString(file, "keep\n")
      const before = (yield* db.listSessions({ stopped: true })).map((row) => row.id)
      allocationNameSource.leaves = ["abcd", "abce"]
      const failed = yield* Effect.flip(sessions.spawn(yield* spawnInput(repo))).pipe(
        Effect.ensuring(Effect.sync(() => (allocationNameSource.leaves = undefined))),
      )
      assert.strictEqual(failed._tag, "AllocationFailed")
      assert.include(failed.message, "no unused 4-hex")
      assert.lengthOf(yield* herdr.callsTo("open"), 0)
      assert.strictEqual(yield* fs.readFileString(file), "keep\n")
      assert.deepStrictEqual(
        (yield* db.listSessions({ stopped: true })).map((row) => row.id),
        before,
      )
    }),
  )
})
