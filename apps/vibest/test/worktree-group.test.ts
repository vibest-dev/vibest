// New worktrees are worktrees/<repository name>/<4 hex>, recorded as the session's directory. The name is reserved by
// creating its directory, so whatever already sits at a path (a directory, a file, a dangling link) takes that name.
import { assert, describe, it } from "@effect/vitest"
import type { HarnessId } from "@vibest/core/harness"
import { Layout, sameWorktreeBucket } from "@vibest/core/paths"
import { Sessions } from "@vibest/core/sessions"
import { Storage, type SessionRow } from "@vibest/core/storage"
import { KIND as RUNTIME } from "@vibest/runtime-herdr/terminal-runtime"
import { ID } from "@vibest/schema/id"
import { allocationNameSource } from "@vibest/vibest/workspace"
import { repositoryDirectoryName } from "@vibest/vibest/worktree"
import { Effect, FileSystem, Path, type Scope } from "effect"

import { FakeRuntime, makeRepository, sh, testLayer, type TestServices, until, projectOf } from "./fakes.ts"

const spawnInput = (repo: string, harness: HarnessId = "pi") =>
  Effect.map(
    projectOf(repo),
    (projectId) =>
      ({ machine: { id: "local" }, root: repo, key: projectId, name: "task", prompt: "do it", harness }) as const,
  )

const test = <E>(name: string, program: Effect.Effect<void, E, TestServices | Scope.Scope>) =>
  it.effect(name, () => program.pipe(Effect.provide(testLayer())))

const storedRow = (
  id: string,
  metadata: SessionRow["metadata"],
  patch: Partial<Omit<SessionRow, "projectId" | "id" | "metadata">> = {},
): Omit<SessionRow, "scope"> => ({
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
  turnState: "none",
  turnPromptedAt: 0,
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

const directoryOf = (id: string) =>
  Effect.flatMap(Storage, (db) => db.sessionDirectory(id)).pipe(Effect.map((d) => d ?? ""))

describe("repository-grouped worktrees", () => {
  test(
    "a new worktree is the repository name plus a 4-hex leaf, and the full session id stays",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const layout = yield* Layout
      const sessions = yield* Sessions
      const db = yield* Storage
      const repo = yield* makeRepository
      const { id } = yield* sessions.spawn(yield* spawnInput(repo))
      yield* until(db.getSession(id), (w): w is NonNullable<typeof w> => w?.turnState === "open")
      const wt = yield* directoryOf(id)
      const leaf = path.basename(wt)
      assert.match(id, ID)
      assert.match(leaf, /^[0-9a-f]{4}$/)
      assert.notStrictEqual(leaf, id)
      assert.strictEqual(path.basename(path.dirname(wt)), yield* repositoryDirectoryName(repo))
      assert.strictEqual(wt, layout.allocationWorktree(path.basename(repo), leaf))
      assert.isTrue(yield* fs.exists(wt))
      assert.strictEqual(yield* sh(wt, "branch", "--show-current"), "")
      yield* sh(wt, "switch", "-c", "done")
      assert.strictEqual(yield* sh(wt, "branch", "--show-current"), "done")
      assert.strictEqual(path.basename(yield* fs.realPath(wt)), leaf)
      assert.strictEqual((yield* sessions.get(id)).worktree, wt)
    }),
  )

  test(
    "a name whose directory already exists is skipped and left untouched",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const layout = yield* Layout
      const db = yield* Storage
      const sessions = yield* Sessions
      const repo = yield* makeRepository
      allocationNameSource.leaves = ["ab01", "ab02"]
      const reset = Effect.ensuring(Effect.sync(() => (allocationNameSource.leaves = undefined)))
      const repository = yield* repositoryDirectoryName(repo)
      const taken = layout.allocationWorktree(repository, "ab01")
      yield* marker(taken)
      const { id } = yield* sessions.spawn(yield* spawnInput(repo)).pipe(reset)
      assert.strictEqual(yield* directoryOf(id), layout.allocationWorktree(repository, "ab02"))
      yield* until(db.getSession(id), (w) => w?.startedAt !== null)
      assert.strictEqual(yield* fs.readFileString(path.join(taken, "keep")), "keep\n")
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
      yield* sh(repo, "worktree", "add", "-q", "--detach", parent)
      const failed = yield* Effect.flip(sessions.spawn(yield* spawnInput(repo)))
      assert.strictEqual(failed._tag, "AllocationFailed")
      assert.include(failed.message, parent)
      assert.lengthOf(yield* herdr.callsTo("open"), 0)
      assert.isTrue(yield* fs.exists(path.join(parent, ".git")))
      assert.isTrue(yield* fs.exists(path.join(parent, "README.md")))
    }),
  )

  test(
    "a dangling symlink at a name is skipped and left alone",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const layout = yield* Layout
      const db = yield* Storage
      const sessions = yield* Sessions
      const repo = yield* makeRepository
      allocationNameSource.leaves = ["ab01", "ab02"]
      const reset = Effect.ensuring(Effect.sync(() => (allocationNameSource.leaves = undefined)))
      const repository = yield* repositoryDirectoryName(repo)
      const at = layout.allocationWorktree(repository, "ab01")
      yield* fs.makeDirectory(path.dirname(at), { recursive: true })
      yield* fs.symlink("nowhere", at)
      yield* fs.writeFileString(path.join(path.dirname(at), "keep"), "keep\n")
      const { id } = yield* sessions.spawn(yield* spawnInput(repo)).pipe(reset)
      assert.strictEqual(yield* directoryOf(id), layout.allocationWorktree(repository, "ab02"))
      yield* until(db.getSession(id), (w) => w?.startedAt !== null)
      assert.strictEqual(yield* fs.readLink(at), "nowhere")
      assert.strictEqual(yield* fs.readFileString(path.join(path.dirname(at), "keep")), "keep\n")
    }),
  )

  test(
    "a file at the only free name refuses the spawn, and list leaves it beside a real worktree",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const herdr = yield* FakeRuntime
      const layout = yield* Layout
      const db = yield* Storage
      const sessions = yield* Sessions
      const repo = yield* makeRepository
      // Both leaves scripted: the live session takes the first, a plain file sits at the second, so the draw
      // refuses it and the spawn never starts. The file stays beside the real worktree through it all.
      allocationNameSource.leaves = ["ab01", "ab02"]
      const reset = Effect.ensuring(Effect.sync(() => (allocationNameSource.leaves = undefined)))
      const { id: live } = yield* sessions.spawn(yield* spawnInput(repo))
      yield* until(db.getSession(live), (w): w is NonNullable<typeof w> => w?.turnState === "open")
      const liveTree = yield* directoryOf(live)
      const repository = yield* repositoryDirectoryName(repo)
      const file = layout.allocationWorktree(repository, "ab02")
      yield* fs.makeDirectory(path.dirname(file), { recursive: true })
      yield* fs.writeFileString(file, "keep\n")
      const refused = yield* Effect.flip(sessions.spawn(yield* spawnInput(repo)).pipe(reset))
      assert.include(refused.message, "no unused 4-hex worktree name")
      assert.lengthOf(yield* herdr.callsTo("open"), 1)
      const rows = yield* sessions.list()
      const of = (sessionId: string) => rows.find((row) => row.id === sessionId)
      assert.strictEqual(of(live)!.worktree, liveTree)
      assert.ok(of(live)!.git)
      assert.strictEqual(yield* fs.readFileString(file), "keep\n")
      assert.isTrue(yield* fs.exists(liveTree))
    }),
  )

  test(
    "a failed launch removes only the worktree it created",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const db = yield* Storage
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
    "a recorded directory that is gone is reported gone, and nothing else is touched",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const layout = yield* Layout
      const db = yield* Storage
      const sessions = yield* Sessions
      const repo = yield* makeRepository
      const id = "d4e5f6a7-d4e5-4d4e-8d4e-d4e5f6a7d4e5"
      const key = yield* projectOf(repo)
      const repository = yield* repositoryDirectoryName(repo)
      const neighbour = layout.allocationWorktree(repository, "cd35")
      yield* marker(neighbour)
      const grouped = layout.allocationWorktree(repository, "cd34")
      yield* db.insertSession(storedRow(id, {}, { exitedAt: 1 }), key, undefined, grouped)
      const out = (yield* sessions.remove(id))!
      assert.deepInclude(out, { worktree: "gone", path: grouped })
      assert.include(out.reasons.join("\n"), grouped + " was already gone")
      assert.strictEqual(yield* fs.readFileString(neighbour + "/keep"), "keep\n")
    }),
  )

  test(
    "a directory outside worktrees, or none recorded, deletes nothing",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const layout = yield* Layout
      const db = yield* Storage
      const sessions = yield* Sessions
      const repo = yield* makeRepository
      const key = yield* projectOf(repo)
      const outside = "e5f6a7b8-e5f6-4e5f-8e5f-e5f6a7b8e5f6"
      const none = "a7b8c9d0-a7b8-4a7b-8a7b-a7b8c9d0a7b8"
      const elsewhere = path.join(layout.home, "x", outside)
      yield* marker(elsewhere)
      yield* db.insertSession(storedRow(outside, {}), key, undefined, elsewhere)
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
    "a held creation reserves its leaf, so the next draw does not alias it",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const sessions = yield* Sessions
      const db = yield* Storage
      const layout = yield* Layout
      const herdr = yield* FakeRuntime
      const repo = yield* makeRepository
      const other = yield* makeRepository
      yield* sh(repo, "remote", "add", "origin", "git@github.com:Org/MyRepo.git")
      yield* sh(other, "remote", "add", "origin", "git@github.com:Other/myrepo.git")
      const reset = Effect.sync(() => (allocationNameSource.leaves = undefined))
      yield* Effect.gen(function* () {
        allocationNameSource.leaves = ["abcd", "abce"]
        const held = yield* herdr.hold("open")
        const first = yield* sessions.spawn(yield* spawnInput(repo))
        yield* held.reached
        assert.strictEqual(yield* directoryOf(first.id), layout.allocationWorktree("MyRepo", "abcd"))
        // The directory exists before the terminal opens: it is the reservation, so the next draw cannot alias it,
        // even under a name that differs only in case on a case-folding file system.
        assert.isTrue(yield* fs.exists(layout.allocationWorktree("MyRepo", "abcd")))
        allocationNameSource.leaves = ["abcd", "abce"]
        const second = yield* sessions.spawn(yield* spawnInput(other))
        yield* until(db.getSession(second.id), (w): w is NonNullable<typeof w> => w?.turnState === "open")
        const expected = sameWorktreeBucket("MyRepo", "myrepo") ? "abce" : "abcd"
        assert.strictEqual(yield* directoryOf(second.id), layout.allocationWorktree("myrepo", expected))
        yield* held.release()
        yield* until(db.getSession(first.id), (w): w is NonNullable<typeof w> => w?.turnState === "open")
        assert.strictEqual(yield* directoryOf(first.id), layout.allocationWorktree("MyRepo", "abcd"))
        assert.isTrue(yield* fs.exists(layout.allocationWorktree("MyRepo", "abcd")))
      }).pipe(Effect.ensuring(reset))
    }),
  )

  test(
    "exhausting the bounded name list inserts no row",
    Effect.gen(function* () {
      const db = yield* Storage
      const sessions = yield* Sessions
      const layout = yield* Layout
      const repo = yield* makeRepository
      yield* sh(repo, "remote", "add", "origin", "git@github.com:Org/MyRepo.git")
      yield* marker(layout.allocationWorktree("MyRepo", "abcd"))
      const before = (yield* db.listSessions({ stopped: true })).map((row) => row.id)
      allocationNameSource.leaves = ["abcd"]
      const failed = yield* Effect.flip(sessions.spawn(yield* spawnInput(repo))).pipe(
        Effect.ensuring(Effect.sync(() => (allocationNameSource.leaves = undefined))),
      )
      assert.strictEqual(failed._tag, "AllocationFailed")
      assert.include(failed.message, "no unused 4-hex")
      assert.deepStrictEqual(
        (yield* db.listSessions({ stopped: true })).map((row) => row.id),
        before,
      )
    }),
  )
})
