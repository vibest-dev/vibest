// New worktrees are worktrees/<repository name>/<4 hex>. Rows without that record stay flat.
import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Path, type Scope } from "effect"
import { Db, type SessionRow } from "@vibest/core/db"
import { KIND as RUNTIME } from "@vibest/runtime-herdr/terminal-runtime"
import type { HarnessId } from "@vibest/core/harness"
import { Layout, sameWorktreeBucket } from "@vibest/core/paths"
import { allocationNameSource, Sessions } from "@vibest/core/sessions"
import { repositoryDirectoryName, repositoryKey } from "@vibest/core/worktree"
import { FakeRuntime, makeRepository, sh, testLayer, type TestServices, until, writeResult } from "./fakes.ts"

const spawnInput = (repo: string, harness: HarnessId = "pi") =>
  Effect.map(repositoryKey(repo), (key) => ({ machine: { id: "local" }, root: repo, key, name: "task", prompt: "do it", harness }) as const)

const test = <E>(name: string, program: Effect.Effect<void, E, TestServices | Scope.Scope>) =>
  it.effect(name, () => program.pipe(Effect.provide(testLayer())))

const legacyRow = (
  id: string,
  metadata: SessionRow["metadata"],
  patch: Partial<Omit<SessionRow, "projectId" | "id" | "metadata">> = {},
): Omit<SessionRow, "projectId"> => ({
  id,
  agent: "general",
  name: "legacy",
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
  turnPromptedAt: 0, metadata,
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

describe("repository-grouped worktrees", () => {
  test(
    "a new worktree is the repository name plus a 4-hex leaf, and the full session id stays",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const layout = yield* Layout
      const sessions = yield* Sessions
      const db = yield* Db
      const repo = yield* makeRepository
      const { id } = yield* sessions.spawn((yield* spawnInput(repo)))
      const row = yield* until(db.getSession(id), (w): w is NonNullable<typeof w> => w?.turnState === "open")
      const repository = row.metadata.worktreeRepository!
      const leaf = row.metadata.worktreeName!
      assert.match(id, /^[0-9a-f]{8}$/)
      assert.match(leaf, /^[0-9a-f]{4}$/)
      assert.notStrictEqual(leaf, id)
      assert.strictEqual(repository, yield* repositoryDirectoryName(repo))
      assert.strictEqual(repository, path.basename(repo))
      const wt = layout.allocationWorktree(repository, leaf)
      assert.strictEqual(path.basename(wt), leaf)
      assert.isTrue(yield* fs.exists(wt))
      assert.isFalse(yield* fs.exists(layout.legacyWorktree(id)))
      assert.strictEqual(yield* sh(wt, "branch", "--show-current"), "")
      yield* sh(wt, "switch", "-c", "done")
      assert.strictEqual(yield* sh(wt, "branch", "--show-current"), "done")
      assert.strictEqual(path.basename(yield* fs.realPath(wt)), leaf)
      const after = (yield* db.getSession(id))!
      assert.strictEqual(after.id, id)
      assert.strictEqual(after.metadata.worktreeRepository, repository)
      assert.strictEqual(after.metadata.worktreeName, leaf)
    }),
  )

  test(
    "creation refuses the recorded path when it already exists, and does not use the legacy id path",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const layout = yield* Layout
      const db = yield* Db
      const sessions = yield* Sessions
      const repo = yield* makeRepository
      // The first recorded allocation path already holds something (a race lost, or a leftover): the draw refuses
      // that leaf and takes the next one, never writing into the taken path or the legacy flat one.
      allocationNameSource.leaves = ["ab01", "ab02"]
      const reset = Effect.ensuring(Effect.sync(() => (allocationNameSource.leaves = undefined)))
      const repository = yield* repositoryDirectoryName(repo)
      const taken = layout.allocationWorktree(repository, "ab01")
      yield* fs.makeDirectory(taken, { recursive: true })
      yield* fs.writeFileString(path.join(taken, "keep"), "keep\n")
      const { id } = yield* sessions.spawn((yield* spawnInput(repo))).pipe(reset)
      const row = (yield* db.getSession(id))!
      const at = layout.allocationWorktree(row.metadata.worktreeRepository!, row.metadata.worktreeName!)
      assert.strictEqual(at, layout.allocationWorktree(repository, "ab02"))
      const untilSpawned = until(db.getSession(id), (w) => w?.startedAt !== null)
      yield* untilSpawned
      assert.strictEqual(yield* fs.readFileString(path.join(taken, "keep")), "keep\n")
      assert.isFalse(yield* fs.exists(layout.legacyWorktree(id)))
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
      const failed = yield* Effect.flip(sessions.spawn((yield* spawnInput(repo))))
      assert.strictEqual(failed._tag, "AllocationFailed")
      assert.include(failed.message, parent)
      assert.lengthOf(yield* herdr.callsTo("open"), 0)
      assert.isTrue(yield* fs.exists(path.join(parent, ".git")))
      assert.isTrue(yield* fs.exists(path.join(parent, "README.md")))
    }),
  )

  test(
    "creation refuses a dangling symlink at the recorded allocation path",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const layout = yield* Layout
      const db = yield* Db
      const sessions = yield* Sessions
      const repo = yield* makeRepository
      // A dangling symlink is a taken entry: the draw refuses that leaf, leaves the link alone, and takes the next.
      allocationNameSource.leaves = ["ab01", "ab02"]
      const reset = Effect.ensuring(Effect.sync(() => (allocationNameSource.leaves = undefined)))
      const repository = yield* repositoryDirectoryName(repo)
      const at = layout.allocationWorktree(repository, "ab01")
      yield* fs.makeDirectory(path.dirname(at), { recursive: true })
      yield* fs.symlink("nowhere", at)
      yield* fs.writeFileString(path.join(path.dirname(at), "keep"), "keep\n")
      const { id } = yield* sessions.spawn((yield* spawnInput(repo))).pipe(reset)
      const row = (yield* db.getSession(id))!
      assert.strictEqual(layout.allocationWorktree(row.metadata.worktreeRepository!, row.metadata.worktreeName!), layout.allocationWorktree(repository, "ab02"))
      yield* until(db.getSession(id), (w) => w?.startedAt !== null)
      assert.strictEqual(yield* fs.readLink(at), "nowhere")
      assert.strictEqual(yield* fs.readFileString(path.join(path.dirname(at), "keep")), "keep\n")
      assert.isFalse(yield* fs.exists(layout.legacyWorktree(id)))
    }),
  )

  test(
    "a file at the grouped path is refused, then list, get and archive leave it beside a real worktree",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const herdr = yield* FakeRuntime
      const layout = yield* Layout
      const db = yield* Db
      const sessions = yield* Sessions
      const repo = yield* makeRepository
      // Both leaves scripted: the live session takes the first, a plain file sits at the second, so the draw
      // refuses it and the spawn never starts. The file stays beside the real worktree through it all.
      allocationNameSource.leaves = ["ab01", "ab02"]
      const reset = Effect.ensuring(Effect.sync(() => (allocationNameSource.leaves = undefined)))
      const { id: live } = yield* sessions.spawn((yield* spawnInput(repo)))
      const liveRow = yield* until(db.getSession(live), (w): w is NonNullable<typeof w> => w?.turnState === "open")
      const liveTree = layout.allocationWorktree(liveRow.metadata.worktreeRepository!, liveRow.metadata.worktreeName!)
      const repository = yield* repositoryDirectoryName(repo)
      const file = layout.allocationWorktree(repository, "ab02")
      yield* fs.makeDirectory(path.dirname(file), { recursive: true })
      yield* fs.writeFileString(file, "keep\n")
      const refused = yield* Effect.flip(sessions.spawn((yield* spawnInput(repo))).pipe(reset))
      assert.include(refused.message, "no unused 4-hex worktree name")
      assert.lengthOf(yield* herdr.callsTo("open"), 1)
      const rows = yield* sessions.list()
      const of = (sessionId: string) => rows.find((row) => row.id === sessionId)
      assert.strictEqual(of(live)!.worktree, liveTree)
      assert.ok(of(live)!.git)
      // Nothing was created for the refused one: the live worktree and the file are all there is.
      assert.strictEqual(yield* fs.readFileString(file), "keep\n")
      assert.isTrue(yield* fs.exists(liveTree))
    }),
  )

  test(
    "a failed launch removes only the grouped worktree it created",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const layout = yield* Layout
      const db = yield* Db
      const herdr = yield* FakeRuntime
      const repo = yield* makeRepository
      const held = yield* herdr.hold("open")
      const { id } = yield* (yield* Sessions).spawn((yield* spawnInput(repo)))
      yield* held.reached
      const created = (yield* db.getSession(id))!
      const wt = layout.allocationWorktree(created.metadata.worktreeRepository!, created.metadata.worktreeName!)
      const flat = layout.legacyWorktree(id)
      assert.isTrue(yield* fs.exists(wt))
      yield* fs.makeDirectory(flat, { recursive: true })
      yield* fs.writeFileString(path.join(flat, "keep"), "flat\n")
      yield* fs.writeFileString(path.join(path.dirname(wt), "sibling"), "group\n")
      yield* held.release("failed")
      yield* until(db.getSession(id), (w) => !!w && w.exitedAt !== null)
      assert.isFalse(yield* fs.exists(wt))
      assert.strictEqual(yield* fs.readFileString(path.join(flat, "keep")), "flat\n")
      assert.strictEqual(yield* fs.readFileString(path.join(path.dirname(wt), "sibling")), "group\n")
    }),
  )

  test(
    "a legacy row is read, resumed and reported at its flat path",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const layout = yield* Layout
      const db = yield* Db
      const sessions = yield* Sessions
      const herdr = yield* FakeRuntime
      const repo = yield* makeRepository
      const key = yield* repositoryKey(repo)
      const reported = "a1b2c3d4"
      const sent = "b2c3d4e5"
      const link = (id: string) =>
        Effect.gen(function* () {
          const flat = layout.legacyWorktree(id)
          yield* fs.makeDirectory(layout.worktrees, { recursive: true })
          yield* sh(repo, "worktree", "add", "-q", "--detach", flat)
          const decoy = layout.allocationWorktree(yield* repositoryDirectoryName(repo), "ab12")
          yield* fs.makeDirectory(decoy, { recursive: true })
          yield* fs.writeFileString(decoy + "/keep", "decoy\n")
          return { flat, decoy }
        })
      const open = yield* link(reported)
      yield* db.insertSession(legacyRow(reported, {}, { status: "working", startedAt: 1, exitedAt: null, turnState: "open" }), key)
      assert.strictEqual((yield* sessions.get(reported)).worktree, open.flat)
      assert.strictEqual((yield* sessions.list()).find((s) => s.id === reported)!.worktree, open.flat)
      yield* sessions.check(reported)
      const result = (yield* db.latestInbox(reported, "result"))!
      assert.include(result.message, "<worktree>" + open.flat + "</worktree>")
      assert.notInclude(result.message, open.decoy)
      assert.strictEqual(yield* fs.readFileString(open.decoy + "/keep"), "decoy\n")

      const resume = yield* link(sent)
      yield* db.insertSession(legacyRow(sent, {}), key)
      yield* sessions.send(sent, "next")
      const opened = yield* until(herdr.callsTo("open"), (calls) => calls.some((c) => c.cwd === resume.flat))
      assert.isFalse(opened.some((c) => c.cwd === resume.decoy))
    }),
  )

  test(
    "archiving a legacy row removes only its flat worktree",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const layout = yield* Layout
      const db = yield* Db
      const sessions = yield* Sessions
      const repo = yield* makeRepository
      const key = yield* repositoryKey(repo)
      const id = "c3d4e5f6"
      const flat = layout.legacyWorktree(id)
      yield* fs.makeDirectory(layout.worktrees, { recursive: true })
      yield* sh(repo, "worktree", "add", "-q", "--detach", flat)
      const decoy = layout.allocationWorktree(yield* repositoryDirectoryName(repo), "ab12")
      yield* fs.makeDirectory(decoy, { recursive: true })
      yield* fs.writeFileString(decoy + "/keep", "decoy\n")
      yield* db.insertSession(legacyRow(id, { stop: [{ pane: "p", pids: [1], exited: true }] }), key)
      const out = (yield* sessions.remove(id))!
      assert.deepInclude(out, { worktree: "removed", path: flat })
      assert.isFalse(yield* fs.exists(flat))
      assert.strictEqual(yield* fs.readFileString(decoy + "/keep"), "decoy\n")
    }),
  )

  test(
    "a missing grouped path is not replaced by a flat checkout",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const layout = yield* Layout
      const db = yield* Db
      const sessions = yield* Sessions
      const repo = yield* makeRepository
      const id = "d4e5f6a7"
      const key = yield* repositoryKey(repo)
      const flat = layout.legacyWorktree(id)
      yield* fs.makeDirectory(layout.worktrees, { recursive: true })
      yield* sh(repo, "worktree", "add", "-q", "--detach", flat)
      yield* fs.writeFileString(flat + "/keep", "flat\n")
      const repository = yield* repositoryDirectoryName(repo)
      const grouped = layout.allocationWorktree(repository, "cd34")
      yield* db.insertSession(legacyRow(id, { worktreeRepository: repository, worktreeName: "cd34", stop: [{ pane: "p", pids: [1], exited: true }] }), key)
      const out = (yield* sessions.remove(id))!
      assert.deepInclude(out, { worktree: "gone", path: grouped })
      assert.include(out.reasons.join("\n"), grouped + " was already gone")
      assert.strictEqual(yield* fs.readFileString(flat + "/keep"), "flat\n")
    }),
  )

  test(
    "an unsafe group or a missing owner deletes nothing",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const layout = yield* Layout
      const db = yield* Db
      const sessions = yield* Sessions
      const repo = yield* makeRepository
      const key = yield* repositoryKey(repo)
      const escaped = "e5f6a7b8"
      const slash = "f6a7b8c9"
      const borrower = "a7b8c9d0"
      const dirs = [
        path.join(layout.home, "x", escaped),
        layout.legacyWorktree(escaped),
        path.join(layout.worktrees, "a", "b", slash),
        layout.legacyWorktree(slash),
        layout.legacyWorktree(borrower),
        layout.legacyWorktree("01234567"),
      ]
      for (const dir of dirs) yield* marker(dir)
      yield* db.insertSession(legacyRow(escaped, { worktreeRepository: "../x", worktreeName: "ab12" }), key)
      yield* db.insertSession(legacyRow(slash, { worktreeRepository: "a/b", worktreeName: "ab12" }), key)
      yield* db.insertSession(legacyRow(borrower, { peer: "01234567" }), key)
      for (const id of [escaped, slash, borrower]) {
        const out = (yield* sessions.remove(id))!
        assert.strictEqual(out.worktree, "kept", id)
        assert.strictEqual(out.path, "", id)
        assert.include(out.reasons.join("\n"), "nothing was deleted", id)
      }
      for (const dir of dirs) assert.strictEqual(yield* fs.readFileString(path.join(dir, "keep")), "keep\n", dir)
    }),
  )

  test(
    "a peer of a legacy owner uses the flat path and does not remove it",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const layout = yield* Layout
      const db = yield* Db
      const sessions = yield* Sessions
      const herdr = yield* FakeRuntime
      const repo = yield* makeRepository
      const key = yield* repositoryKey(repo)
      const id = "b8c9d0e1"
      const flat = layout.legacyWorktree(id)
      yield* fs.makeDirectory(layout.worktrees, { recursive: true })
      yield* sh(repo, "worktree", "add", "-q", "--detach", flat)
      const decoy = layout.allocationWorktree(yield* repositoryDirectoryName(repo), "ab12")
      yield* fs.makeDirectory(decoy, { recursive: true })
      yield* fs.writeFileString(decoy + "/keep", "decoy\n")
      const owner = `owner:${id}`
      yield* herdr.addPane(owner, owner.split(":")[0]!, flat)
      yield* herdr.seedAgent(owner)
      yield* db.insertSession(legacyRow(id, {}), key)
      const spawned = yield* sessions.spawn({ ...(yield* spawnInput(repo)), peer: id })
      const peerRow = yield* until(db.getSession(spawned.id), (w): w is NonNullable<typeof w> => !!w && (w.startedAt !== null || w.exitedAt !== null))
      assert.strictEqual(peerRow.metadata.peer, id)
      assert.isUndefined(peerRow.metadata.worktreeRepository)
      assert.isUndefined(peerRow.metadata.worktreeName)
      assert.strictEqual((yield* sessions.get(spawned.id)).worktree, flat)
      // Only the owner's terminal, placed above: the peer is split from it.
      assert.lengthOf(yield* herdr.callsTo("open"), 1)
      yield* writeResult(spawned.id, "pi", { text: "status: completed" })
      yield* herdr.endTurn((spawned.id))
      yield* sessions.check(spawned.id)
      const borrower = (yield* sessions.remove(spawned.id))!
      assert.deepInclude(borrower, { worktree: "kept", path: flat })
      assert.isTrue(yield* fs.exists(flat))
      const ownerOut = (yield* sessions.remove(id))!
      assert.deepInclude(ownerOut, { worktree: "removed", path: flat })
      assert.isFalse(yield* fs.exists(flat))
      assert.strictEqual(yield* fs.readFileString(decoy + "/keep"), "decoy\n")
    }),
  )

  test(
    "list keeps an unsafe row and a missing owner beside a real worktree",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const layout = yield* Layout
      const db = yield* Db
      const sessions = yield* Sessions
      const repo = yield* makeRepository
      const key = yield* repositoryKey(repo)
      const valid = "aa11bb22"
      const bad = "cc33dd44"
      const borrower = "dd44ee55"
      const flat = layout.legacyWorktree(valid)
      yield* fs.makeDirectory(layout.worktrees, { recursive: true })
      yield* sh(repo, "worktree", "add", "-q", "--detach", flat)
      const escaped = path.join(layout.home, "x", bad)
      yield* marker(escaped)
      yield* marker(layout.legacyWorktree(bad))
      yield* marker(layout.legacyWorktree(borrower))
      yield* db.insertSession(legacyRow(valid, {}), key)
      yield* db.insertSession(legacyRow(bad, { worktreeRepository: "../x", worktreeName: "ab12" }), key)
      yield* db.insertSession(legacyRow(borrower, { peer: "01234567" }), key)
      const rows = yield* sessions.list()
      const of = (id: string) => rows.find((row) => row.id === id)!
      assert.strictEqual(of(valid).worktree, flat)
      assert.ok(of(valid).git)
      assert.strictEqual(of(valid).repositoryRoot, repo)
      for (const id of [bad, borrower]) {
        assert.strictEqual(of(id).worktree, "", id)
        assert.isUndefined(of(id).git, id)
        assert.isUndefined(of(id).repositoryRoot, id)
      }
      const unsafe = yield* Effect.flip(sessions.get(bad))
      const missing = yield* Effect.flip(sessions.get(borrower))
      const sent = yield* Effect.flip(sessions.send(bad, "next"))
      assert.strictEqual(unsafe._tag, "NoSuchSession")
      assert.include(unsafe.message, "../x")
      assert.include(missing.message, "no row")
      assert.include(sent.message, "../x")
      const removed = (yield* sessions.remove(bad))!
      assert.deepInclude(removed, { worktree: "kept", path: "" })
      assert.include(removed.reasons.join("\n"), "nothing was deleted")
      assert.strictEqual(yield* fs.readFileString(path.join(escaped, "keep")), "keep\n")
      assert.strictEqual(yield* fs.readFileString(path.join(layout.legacyWorktree(bad), "keep")), "keep\n")
      assert.isTrue(yield* fs.exists(flat))
    }),
  )

  test(
    "a recorded leaf stays reserved when the directory is gone, including a different case of the same bucket",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const db = yield* Db
      const sessions = yield* Sessions
      const layout = yield* Layout
      const repo = yield* makeRepository
      yield* sh(repo, "remote", "add", "origin", "git@github.com:Org/MyRepo.git")
      const other = yield* makeRepository
      yield* sh(other, "remote", "add", "origin", "git@github.com:Other/myrepo.git")
      const key = yield* repositoryKey(repo)
      assert.notStrictEqual(key, yield* repositoryKey(other))
      yield* db.insertSession(legacyRow("1111aaaa", { worktreeRepository: "MyRepo", worktreeName: "abcd" }), key)
      assert.isFalse(yield* fs.exists(layout.allocationWorktree("MyRepo", "abcd")))
      allocationNameSource.leaves = ["abcd", "abce"]
      const spawned = yield* sessions.spawn((yield* spawnInput(other))).pipe(Effect.ensuring(Effect.sync(() => (allocationNameSource.leaves = undefined))))
      const row = yield* until(db.getSession(spawned.id), (w): w is NonNullable<typeof w> => w?.turnState === "open")
      const expected = sameWorktreeBucket("MyRepo", "myrepo") ? "abce" : "abcd"
      assert.strictEqual(row.metadata.worktreeRepository, "myrepo")
      assert.strictEqual(row.metadata.worktreeName, expected)
      const historical = yield* sessions.get("1111aaaa")
      assert.strictEqual(historical.worktree, layout.allocationWorktree("MyRepo", "abcd"))
      assert.notStrictEqual(historical.worktree, (yield* sessions.get(spawned.id)).worktree)
      assert.isUndefined(historical.git)
      assert.isFalse(yield* fs.exists(layout.allocationWorktree("MyRepo", "abcd")))
    }),
  )

  test(
    "a held creation reserves its leaf, so the next draw does not alias it",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const db = yield* Db
      const sessions = yield* Sessions
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
        const first = yield* sessions.spawn((yield* spawnInput(repo)))
        yield* held.reached
        const owner = (yield* db.getSession(first.id))!
        assert.strictEqual(owner.metadata.worktreeRepository, "MyRepo")
        assert.strictEqual(owner.metadata.worktreeName, "abcd")
        // The worktree exists before the terminal opens (its cwd is in it); the leaf reservation in the row is what
        // keeps the next draw from aliasing it either way.
        assert.isTrue(yield* fs.exists(layout.allocationWorktree("MyRepo", "abcd")))
        allocationNameSource.leaves = ["abcd", "abce"]
        const second = yield* sessions.spawn((yield* spawnInput(other)))
        const otherRow = yield* until(db.getSession(second.id), (w): w is NonNullable<typeof w> => w?.turnState === "open")
        assert.strictEqual(otherRow.metadata.worktreeName, sameWorktreeBucket("MyRepo", "myrepo") ? "abce" : "abcd")
        assert.strictEqual((yield* db.getSession(first.id))!.metadata.worktreeName, "abcd")
        assert.notStrictEqual((yield* sessions.get(first.id)).worktree, (yield* sessions.get(second.id)).worktree)
        yield* held.release()
        const created = yield* until(db.getSession(first.id), (w): w is NonNullable<typeof w> => w?.turnState === "open")
        assert.strictEqual(created.metadata.worktreeName, "abcd")
        assert.isTrue(yield* fs.exists(layout.allocationWorktree("MyRepo", "abcd")))
        assert.isUndefined((yield* db.getSession(first.id))!.metadata.peer)
        assert.isUndefined(otherRow.metadata.peer)
      }).pipe(Effect.ensuring(reset))
    }),
  )

  test(
    "exhausting the bounded name list inserts no row and does not invent a legacy path",
    Effect.gen(function* () {
      const db = yield* Db
      const sessions = yield* Sessions
      const repo = yield* makeRepository
      yield* sh(repo, "remote", "add", "origin", "git@github.com:Org/MyRepo.git")
      const key = yield* repositoryKey(repo)
      yield* db.insertSession(legacyRow("1111aaaa", { worktreeRepository: "MyRepo", worktreeName: "abcd" }), key)
      const before = (yield* db.listSessions({ stopped: true })).map((row) => row.id)
      allocationNameSource.leaves = ["abcd"]
      const failed = yield* Effect.flip(sessions.spawn((yield* spawnInput(repo)))).pipe(Effect.ensuring(Effect.sync(() => (allocationNameSource.leaves = undefined))))
      assert.strictEqual(failed._tag, "AllocationFailed")
      assert.include(failed.message, "no unused 4-hex")
      assert.deepStrictEqual((yield* db.listSessions({ stopped: true })).map((row) => row.id), before)
    }),
  )
})
