import { assert, describe, it, layer } from "@effect/vitest"
import { Bus } from "@vibest/core/bus"
import { Db } from "@vibest/core/database/db"
import type { NewSession } from "@vibest/core/database/db-rows"
import * as Projectors from "@vibest/core/database/projectors"
import { Git } from "@vibest/core/git"
import {
  createIsolatedWorktrees,
  createProject,
  listProjectRepositories,
  projectRoot,
} from "@vibest/core/project/create"
import { locateProject, resolveProject } from "@vibest/core/project/identity"
import { SessionLive } from "@vibest/core/session/live"
import { copyIncluded, gitState, mainCheckout } from "@vibest/core/worktree"
import { KIND as RUNTIME } from "@vibest/runtime-herdr/terminal-runtime"
import { Layout } from "@vibest/schema/layout"
import { tempDirectory } from "@vibest/server/test/lib/fakes"
import { Effect, Exit, Fiber, FileSystem, Layer, Option, Path, type Scope, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { TestClock } from "effect/testing"

import * as Platform from "#platform"

const ownGitHome = Layer.effect(
  ChildProcessSpawner.ChildProcessSpawner,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const home = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "vibest-git-home-" }))
    const env = { HOME: home, XDG_CONFIG_HOME: home, GIT_CONFIG_NOSYSTEM: "1" }
    return ChildProcessSpawner.make((command) =>
      spawner.spawn(
        command._tag === "StandardCommand"
          ? ChildProcess.make(command.command, command.args, {
              ...command.options,
              env: { ...command.options.env, ...env },
              extendEnv: true,
            })
          : command,
      ),
    )
  }),
).pipe(Layer.orDie)

const live = Git.layer.pipe(Layer.provideMerge(ownGitHome), Layer.provideMerge(Platform.services))

const sh = (cwd: string, ...args: string[]) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const handle = yield* spawner.spawn(
      ChildProcess.make("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd }),
    )
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        Stream.mkString(Stream.decodeText(handle.stdout)),
        Stream.mkString(Stream.decodeText(handle.stderr)),
        handle.exitCode,
      ],
      { concurrency: "unbounded" },
    )
    if (exitCode !== 0) return yield* Effect.die(new Error(`git ${args.join(" ")}: ${stderr.trim()}`))
    return stdout.trim()
  }).pipe(Effect.scoped, Effect.orDie)

const repositoryWithOneCommitOnMain = (parent: string, name: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const root = path.join(parent, name)
    yield* fs.makeDirectory(root, { recursive: true })
    yield* sh(root, "init", "-q", "-b", "main")
    yield* fs.writeFileString(path.join(root, "README.md"), `${name}\n`)
    yield* sh(root, "add", ".")
    yield* sh(root, "commit", "-q", "-m", "init")
    return root
  }).pipe(Effect.orDie)

const makeRepository = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = yield* repositoryWithOneCommitOnMain(yield* tempDirectory("vibest-repo-"), "repo")
  yield* fs.writeFileString(path.join(root, "CLAUDE.md"), "local rules\n")
  return root
})

const scopedRealPathTempDirectory = tempDirectory

const test = <E>(
  name: string,
  program: Effect.Effect<void, E, Layer.Success<typeof live> | Scope.Scope>,
  timeout?: number,
) => {
  const run = () => program.pipe(Effect.provide(live))
  return timeout === undefined ? it.effect(name, run) : it.effect(name, run, timeout)
}

const failure = <A, E extends { message: string }, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(effect)
    if (Exit.isSuccess(exit)) return assert.fail("expected a failure")
    const error = exit.cause.reasons.find((r) => r._tag === "Fail")
    return error?._tag === "Fail" ? error.error.message : assert.fail(`not a failure: ${exit.cause}`)
  })

const database = (filename: string) =>
  Db.layer.pipe(
    Layer.provide(Projectors.layer),
    Layer.provide(Bus.layer),
    Layer.provide(SessionLive.layer),
    Layer.provide(Platform.sqlite(filename)),
  )

const session = (id: string): Omit<NewSession, "projectId"> => ({
  id,
  agent: "general",
  name: "n",
  harnessId: "pi",
  provider: null,
  model: null,
  harnessSessionId: null,
  runtime: RUNTIME,
  address: { machine: "local", id: "default" },
  status: "unknown",
  startedAt: null,
  exitedAt: null,
  executionState: "none",
  executionPromptedAt: 0,
  createdAt: 1,
  lastActive: 1,
})

describe("git, the live layer: worktree add and remove", () => {
  test(
    "the main checkout from anywhere inside, a linked worktree included; add lists it, remove deletes it, git refuses a dirty one",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const git = yield* Git.Service
      const repo = yield* makeRepository
      assert.strictEqual(yield* mainCheckout(repo), repo)
      yield* fs.makeDirectory(path.join(repo, "sub"))
      assert.strictEqual(yield* mainCheckout(path.join(repo, "sub")), repo)
      assert.isTrue(yield* git.isMainCheckout(path.join(repo, "sub")))
      assert.strictEqual(
        (yield* Effect.flip(mainCheckout(yield* tempDirectory("vibest-none-"))))._tag,
        "NotInRepository",
      )
      const linked = path.join(yield* tempDirectory("vibest-linked-"), "wt")
      yield* git.addWorktree(repo, linked)
      assert.strictEqual(yield* mainCheckout(linked), repo)
      assert.isFalse(yield* git.isMainCheckout(linked))
      assert.strictEqual(yield* git.topLevel(path.join(linked)), linked)
      assert.strictEqual(yield* fs.readFileString(path.join(linked, "README.md")), "repo\n")
      assert.isFalse(yield* fs.exists(path.join(linked, "CLAUDE.md")))
      assert.deepStrictEqual(yield* git.linkedWorktrees(repo), [linked])
      assert.deepStrictEqual(yield* git.uncommitted(repo), ["?? CLAUDE.md"])
      assert.strictEqual(yield* git.currentBranch(repo), "main")
      assert.strictEqual(yield* git.currentBranch(linked), "")
      assert.isUndefined(yield* git.originUrl(repo))
      yield* sh(repo, "remote", "add", "origin", "git@github.com:Org/MyRepo.git")
      assert.strictEqual(yield* git.originUrl(linked), "git@github.com:Org/MyRepo.git")

      yield* fs.writeFileString(path.join(linked, "x.txt"), "x\n")
      assert.include((yield* Effect.flip(git.removeWorktree(repo, linked))).message, "untracked")
      yield* fs.remove(path.join(linked, "x.txt"))
      yield* git.removeWorktree(repo, linked)
      assert.isFalse(yield* fs.exists(linked))
      assert.deepStrictEqual(yield* git.linkedWorktrees(repo), [])
    }),
  )
})

describe("git, the live layer: reading a worktree's git state", () => {
  test(
    "takes no index lock, so a spawn's git worktree add at that moment does not fail on index.lock",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const repo = yield* makeRepository
      const index = path.join(repo, ".git", "index")
      const before = (yield* fs.stat(index)).ino
      yield* gitState(repo)
      assert.deepStrictEqual((yield* fs.stat(index)).ino, before)
    }),
  )
})

describe("git, the live layer: project copies", () => {
  test(
    "copies each repository as an independent clone on its branch, origin preserved, uncommitted changes reported",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const sources = yield* scopedRealPathTempDirectory("vibest-sources-")
      const app = yield* repositoryWithOneCommitOnMain(sources, "local-app")
      yield* sh(app, "remote", "add", "origin", "https://example.com/acme/app.git")
      yield* sh(app, "update-ref", "refs/remotes/origin/main", "HEAD")
      yield* sh(app, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main")
      yield* sh(app, "switch", "-q", "-c", "feature")
      yield* sh(app, "config", "branch.feature.remote", "origin")
      yield* sh(app, "config", "branch.feature.merge", "refs/heads/main")
      yield* fs.writeFileString(path.join(app, "README.md"), "edited\n")
      yield* fs.writeFileString(path.join(app, "new.txt"), "new\n")
      const sdk = yield* repositoryWithOneCommitOnMain(sources, "sdk")

      const directory = path.join(yield* scopedRealPathTempDirectory("vibest-project-"), "combo")
      const project = yield* createProject(directory, [app, path.join(sdk, ".")])
      assert.strictEqual(project.directory, directory)
      assert.deepStrictEqual(
        project.folders.map((f) => [f.name, f.source, f.path, f.branch, f.origin]),
        [
          ["app", app, path.join(directory, "app"), "feature", "https://example.com/acme/app.git"],
          ["sdk", sdk, path.join(directory, "sdk"), "main", undefined],
        ],
      )
      assert.deepStrictEqual(project.folders[0]!.uncommitted, [" M README.md", "?? new.txt"])
      assert.deepStrictEqual(project.folders[1]!.uncommitted, [])

      const copy = path.join(directory, "app")
      assert.strictEqual((yield* fs.stat(copy)).type, "Directory")
      assert.strictEqual(yield* fs.readFileString(path.join(copy, "README.md")), "local-app\n")
      assert.isFalse(yield* fs.exists(path.join(copy, "new.txt")))
      assert.strictEqual(yield* sh(copy, "branch", "--show-current"), "feature")
      assert.strictEqual(yield* sh(copy, "remote"), "origin")
      assert.strictEqual(yield* sh(copy, "config", "--get", "remote.origin.url"), "https://example.com/acme/app.git")
      assert.strictEqual(yield* sh(copy, "rev-parse", "origin/main"), yield* sh(app, "rev-parse", "origin/main"))
      assert.strictEqual(yield* sh(copy, "symbolic-ref", "refs/remotes/origin/HEAD"), "refs/remotes/origin/main")
      assert.strictEqual(yield* sh(copy, "rev-parse", "--abbrev-ref", "@{upstream}"), "origin/main")
      assert.isFalse(yield* fs.exists(path.join(copy, ".git/objects/info/alternates")))
      const head = yield* sh(copy, "rev-parse", "HEAD")
      const headObject = path.join(copy, ".git/objects", head.slice(0, 2), head.slice(2))
      assert.strictEqual(Option.getOrUndefined((yield* fs.stat(headObject)).nlink), 1)

      const plain = path.join(directory, "sdk")
      assert.strictEqual(yield* sh(plain, "remote"), "")
      assert.strictEqual(yield* sh(plain, "branch", "--show-current"), "main")
      assert.strictEqual(yield* sh(app, "status", "--porcelain"), "M README.md\n?? new.txt")
    }),
  )

  test(
    "a failed copy (an unborn repository passes inspection, then fails the clone) removes only what the call created",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const sources = yield* scopedRealPathTempDirectory("vibest-sources-")
      const app = yield* repositoryWithOneCommitOnMain(sources, "app")
      const unbornRepository = path.join(sources, "unborn")
      yield* fs.makeDirectory(unbornRepository)
      yield* sh(unbornRepository, "init", "-q", "-b", "main")
      const base = yield* scopedRealPathTempDirectory("vibest-project-")

      const fresh = path.join(base, "fresh")
      assert.match(yield* failure(createProject(fresh, [app, unbornRepository])), /copy .*unborn/)
      assert.isFalse(yield* fs.exists(fresh))

      const kept = path.join(base, "kept")
      yield* fs.makeDirectory(kept)
      assert.match(yield* failure(createProject(kept, [app, unbornRepository])), /copy .*unborn/)
      assert.deepStrictEqual(yield* fs.readDirectory(kept), [])
    }),
  )

  test(
    "an interrupt during checkout (a slow smudge filter set in the environment, as a clone skips the source's config) removes only what the call created",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const sources = yield* scopedRealPathTempDirectory("vibest-sources-")
      const app = yield* repositoryWithOneCommitOnMain(sources, "app")
      const smudgeFilter = {
        "filter.slow.clean": "cat",
        "filter.slow.smudge": "sleep 30",
        "filter.slow.required": "true",
      }
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          process.env.GIT_CONFIG_COUNT = String(Object.keys(smudgeFilter).length)
          Object.entries(smudgeFilter).forEach(([key, value], i) => {
            process.env[`GIT_CONFIG_KEY_${i}`] = key
            process.env[`GIT_CONFIG_VALUE_${i}`] = value
          })
        }),
        () =>
          Effect.sync(() => {
            delete process.env.GIT_CONFIG_COUNT
            Object.keys(smudgeFilter).forEach((_, i) => {
              delete process.env[`GIT_CONFIG_KEY_${i}`]
              delete process.env[`GIT_CONFIG_VALUE_${i}`]
            })
          }),
      )
      yield* fs.writeFileString(path.join(app, ".gitattributes"), "README.md filter=slow\n")
      yield* sh(app, "add", ".gitattributes")
      yield* sh(app, "commit", "-q", "-m", "slow")
      const waitFor = (file: string) =>
        Effect.gen(function* () {
          for (let i = 0; i < 250; i++) {
            if (yield* fs.exists(file)) return
            yield* TestClock.withLive(Effect.sleep("20 millis"))
          }
          return yield* Effect.die(new Error(`timed out waiting for ${file}`))
        })

      const fresh = path.join(yield* scopedRealPathTempDirectory("vibest-project-"), "fresh")
      const created = yield* Effect.forkChild(createProject(fresh, [app]))
      yield* waitFor(path.join(fresh, "app"))
      yield* Fiber.interrupt(created)
      assert.isTrue(Exit.hasInterrupts(yield* Fiber.await(created)))
      assert.isFalse(yield* fs.exists(fresh))

      const kept = path.join(yield* scopedRealPathTempDirectory("vibest-project-"), "kept")
      yield* fs.makeDirectory(kept)
      const into = yield* Effect.forkChild(createProject(kept, [app]))
      yield* waitFor(path.join(kept, "app"))
      yield* Fiber.interrupt(into)
      assert.isTrue(Exit.hasInterrupts(yield* Fiber.await(into)))
      assert.isTrue(yield* fs.exists(kept))
      assert.deepStrictEqual(yield* fs.readDirectory(kept), [])

      const root = path.join(yield* scopedRealPathTempDirectory("vibest-multi-"), "combo")
      yield* fs.makeDirectory(root)
      yield* fs.rename(app, path.join(root, "app"))
      const folders = (yield* listProjectRepositories(root))!
      const workspace = path.join(path.dirname(root), "ws")
      const trees = yield* Effect.forkChild(createIsolatedWorktrees(folders, workspace))
      yield* waitFor(path.join(workspace, "app"))
      yield* Fiber.interrupt(trees)
      assert.isTrue(Exit.hasInterrupts(yield* Fiber.await(trees)))
      assert.isFalse(yield* fs.exists(workspace))
      assert.strictEqual(yield* sh(path.join(root, "app"), "branch", "--list", "vibest/*"), "")
    }),
    20_000,
  )

  test(
    "isolated worktrees are created detached, with no branch left behind",
    Effect.gen(function* () {
      const path = yield* Path.Path
      const parent = yield* scopedRealPathTempDirectory("vibest-multi-")
      const root = path.join(parent, "combo")
      const fs = yield* FileSystem.FileSystem
      yield* fs.makeDirectory(root)
      yield* repositoryWithOneCommitOnMain(root, "app")
      yield* repositoryWithOneCommitOnMain(root, "sdk")
      const folders = (yield* listProjectRepositories(root))!
      const workspace = path.join(parent, "ws")
      const made = yield* createIsolatedWorktrees(folders, workspace)
      assert.deepStrictEqual(made, [path.join(workspace, "app"), path.join(workspace, "sdk")])
      for (const folder of folders) {
        const wt = path.join(workspace, folder.name)
        assert.strictEqual(yield* sh(wt, "branch", "--show-current"), "")
        assert.strictEqual(yield* sh(folder.path, "branch", "--list", "vibest/*"), "")
        assert.strictEqual(yield* sh(wt, "rev-parse", "HEAD"), yield* sh(folder.path, "rev-parse", "HEAD"))
      }
      const fromWorkspace = yield* projectRoot(workspace)
      assert.strictEqual(fromWorkspace.root, root)
    }),
  )

  test(
    "a failed copy (a tracked file that is a directory in the folder) removes the worktrees this call created; a leftover branch name never blocks it",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const parent = yield* scopedRealPathTempDirectory("vibest-multi-")
      const root = path.join(parent, "combo")
      yield* fs.makeDirectory(root)
      const app = yield* repositoryWithOneCommitOnMain(root, "app")
      const sdk = yield* repositoryWithOneCommitOnMain(root, "sdk")
      yield* sh(sdk, "branch", "vibest/ab12")
      const kept = yield* sh(sdk, "rev-parse", "refs/heads/vibest/ab12")
      yield* fs.writeFileString(path.join(sdk, "cfg"), "file\n")
      yield* sh(sdk, "add", "cfg")
      yield* sh(sdk, "commit", "-q", "-m", "cfg")
      yield* fs.remove(path.join(sdk, "cfg"))
      yield* fs.makeDirectory(path.join(sdk, "cfg"))
      yield* fs.writeFileString(path.join(sdk, "cfg", "x"), "x\n")
      yield* fs.writeFileString(path.join(sdk, ".git", "info", "exclude"), "cfg/\n", { flag: "a" })
      yield* fs.writeFileString(path.join(sdk, ".worktreeinclude"), "cfg/x\n")
      const folders = (yield* listProjectRepositories(root))!
      const workspace = path.join(parent, "ws")
      assert.match(yield* failure(createIsolatedWorktrees(folders, workspace)), /ENOTDIR/)
      assert.isFalse(yield* fs.exists(workspace))
      assert.notInclude(yield* sh(app, "worktree", "list", "--porcelain"), workspace)
      assert.strictEqual(yield* sh(sdk, "rev-parse", "refs/heads/vibest/ab12"), kept)
      assert.strictEqual(yield* sh(app, "branch", "--list", "vibest/*"), "")
    }),
  )
})

layer(live)("git, the live layer: state, paths, included files and its worktree files", (it) => {
  const addWorktree = (repo: string) =>
    Effect.gen(function* () {
      const wt = (yield* Path.Path).join(yield* tempDirectory("vibest-wt-"), "w")
      yield* sh(repo, "worktree", "add", "-q", "--detach", wt)
      return wt
    })
  const policy = (repo: string, ignore: string, include?: string) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      yield* fs.writeFileString(`${repo}/.gitignore`, ignore)
      yield* sh(repo, "add", ".gitignore")
      yield* sh(repo, "commit", "-q", "-m", "ignore")
      if (include !== undefined) yield* fs.writeFileString(`${repo}/.worktreeinclude`, include)
    })
  const write = (file: string, content: string) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      yield* fs.makeDirectory((yield* Path.Path).dirname(file), { recursive: true })
      yield* fs.writeFileString(file, content)
    })

  it.effect(
    "a moved checkout: ProjectMoved; move keeps the id and repairs vibest's worktrees, not the user's; no move, or the old directory still there, is another project",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const dir = yield* tempDirectory("vibest-move-")
        const file = path.join(dir, "vibest.db")
        const home = path.join(dir, "home")
        yield* Effect.gen(function* () {
          const db = yield* Db
          const layout = yield* Layout
          const resolve = (directory: string, move?: boolean) =>
            Effect.flatMap(locateProject(directory), (located) => resolveProject(db, located, move))
          const repo = path.join(dir, "a", "repo")
          yield* fs.makeDirectory(repo, { recursive: true })
          yield* sh(repo, "init", "-q", "-b", "main")
          yield* sh(
            repo,
            "-c",
            "user.email=t@example.com",
            "-c",
            "user.name=t",
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            "i",
          )
          yield* sh(repo, "remote", "add", "origin", "git@github.com:O/R.git")
          const first = yield* resolve(repo)
          yield* db.insertSession(session("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), first.id, { cwd: repo })
          yield* db.insertSession(session("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"), first.id, { cwd: `${repo}/sub` })
          yield* db.insertSession(session("cccccccc-cccc-4ccc-8ccc-cccccccccccc"), first.id, { cwd: `${repo}-other` })
          const ours = layout.allocationWorktree("repo", "ab12")
          yield* fs.makeDirectory(path.dirname(ours), { recursive: true })
          yield* sh(repo, "worktree", "add", "-q", "--detach", ours)
          const theirs = path.join(dir, "theirs")
          yield* sh(repo, "worktree", "add", "-q", "--detach", theirs)
          const theirsGit = yield* fs.readFileString(path.join(theirs, ".git"))
          const copy = path.join(dir, "copy")
          yield* sh(dir, "clone", "-q", repo, copy)
          yield* sh(copy, "remote", "set-url", "origin", "git@github.com:O/R.git")
          assert.notStrictEqual((yield* resolve(copy)).id, first.id)
          const moved = path.join(dir, "b", "repo")
          yield* fs.makeDirectory(path.dirname(moved))
          yield* fs.rename(repo, moved)
          const asked = yield* Effect.flip(resolve(moved))
          assert.strictEqual(asked._tag, "ProjectMoved")
          assert.deepStrictEqual(asked._tag === "ProjectMoved" ? [asked.projectId, asked.from, asked.to] : [], [
            first.id,
            repo,
            moved,
          ])
          assert.isUndefined(yield* db.projectAt(moved))
          const done = yield* resolve(moved, true)
          assert.strictEqual(done.id, first.id)
          assert.strictEqual(done.directory, moved)
          assert.deepStrictEqual("moved" in done && done.moved, {
            from: repo,
            repaired: [ours],
            manual: [`git -C ${moved} worktree repair ${theirs}`],
          })
          assert.deepStrictEqual(yield* db.projectAt(moved), { id: first.id, directory: moved })
          assert.strictEqual(yield* db.sessionDirectory("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), moved)
          assert.strictEqual(yield* db.sessionDirectory("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"), `${moved}/sub`)
          assert.strictEqual(yield* db.sessionDirectory("cccccccc-cccc-4ccc-8ccc-cccccccccccc"), `${repo}-other`)
          assert.strictEqual(yield* sh(ours, "rev-parse", "--show-toplevel"), yield* fs.realPath(ours))
          assert.strictEqual(yield* fs.readFileString(path.join(theirs, ".git")), theirsGit)
          const again = path.join(dir, "c")
          yield* fs.rename(moved, again)
          const other = yield* resolve(again, false)
          assert.notStrictEqual(other.id, first.id)
          assert.deepStrictEqual(yield* db.projectAt(again), { id: other.id, directory: again })
          assert.strictEqual(yield* db.projectDirectory(first.id), moved)
        }).pipe(Effect.provide(database(file)), Effect.provide(Layer.effect(Layout, Layout.make(home))))
      }),
  )

  it.effect(
    "a move cut off before it is recorded leaves vibest's worktrees repaired and the project where it was; the next answer moves it",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const dir = yield* tempDirectory("vibest-move-")
        yield* Effect.gen(function* () {
          const db = yield* Db
          const layout = yield* Layout
          const resolve = (directory: string, move?: boolean, through = db) =>
            Effect.flatMap(locateProject(directory), (located) => resolveProject(through, located, move))
          const repo = path.join(dir, "a", "repo")
          yield* fs.makeDirectory(repo, { recursive: true })
          yield* sh(repo, "init", "-q", "-b", "main")
          yield* sh(
            repo,
            "-c",
            "user.email=t@example.com",
            "-c",
            "user.name=t",
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            "i",
          )
          yield* sh(repo, "remote", "add", "origin", "git@github.com:O/R.git")
          const first = yield* resolve(repo)
          const ours = layout.allocationWorktree("repo", "ab12")
          yield* fs.makeDirectory(path.dirname(ours), { recursive: true })
          yield* sh(repo, "worktree", "add", "-q", "--detach", ours)
          const moved = path.join(dir, "b", "repo")
          yield* fs.makeDirectory(path.dirname(moved))
          yield* fs.rename(repo, moved)
          const dyingDb = { ...db, moveProject: () => Effect.die("vibestd stopped") }
          assert.isTrue(Exit.isFailure(yield* Effect.exit(resolve(moved, true, dyingDb))))
          assert.strictEqual(yield* sh(ours, "rev-parse", "--show-toplevel"), yield* fs.realPath(ours))
          assert.strictEqual(yield* db.projectDirectory(first.id), repo)
          assert.strictEqual((yield* Effect.flip(resolve(moved)))._tag, "ProjectMoved")
          const done = yield* resolve(moved, true)
          assert.deepStrictEqual("moved" in done && done.moved, { from: repo, repaired: [], manual: [] })
          assert.deepStrictEqual(yield* db.projectAt(moved), { id: first.id, directory: moved })
        }).pipe(
          Effect.provide(database(path.join(dir, "vibest.db"))),
          Effect.provide(Layer.effect(Layout, Layout.make(path.join(dir, "home")))),
        )
      }),
  )

  it.effect("git errors carry stderr", () =>
    Effect.gen(function* () {
      const dir = yield* tempDirectory("vibest-nogit-")
      const error = yield* Effect.flip(Git.Service.use((git) => git.topLevel(dir)))
      assert.include(error.message, "not a git repository")
    }),
  )

  it.effect("detached worktree: copied files are not dirt; loose commits and edits are not saved; a branch is", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const repo = yield* makeRepository
      const wt = path.join(yield* tempDirectory("vibest-wt-"), "w")
      yield* sh(repo, "worktree", "add", "-q", "--detach", wt)
      assert.strictEqual(yield* sh(wt, "branch", "--show-current"), "")
      yield* fs.writeFileString(path.join(repo, ".worktreeinclude"), "local.env\n")
      yield* fs.writeFileString(path.join(repo, ".git", "info", "exclude"), "local.env\n", { flag: "a" })
      yield* fs.writeFileString(path.join(repo, "local.env"), "K=1\n")
      assert.deepStrictEqual(yield* copyIncluded(repo, wt), ["local.env"])
      assert.deepStrictEqual(yield* gitState(wt), { branch: "", pushed: false, saved: true, why: "" })

      yield* fs.writeFileString(path.join(wt, "x.txt"), "x")
      assert.strictEqual((yield* gitState(wt))!.why, "uncommitted changes")
      yield* sh(wt, "add", "x.txt")
      yield* sh(wt, "commit", "-q", "-m", "x")
      assert.strictEqual((yield* gitState(wt))!.why, "commits not on any branch")
      yield* sh(wt, "switch", "-q", "-c", "feat/x")
      assert.deepStrictEqual(yield* gitState(wt), { branch: "feat/x", pushed: false, saved: true, why: "" })
      assert.isUndefined(yield* gitState(path.join(wt, "gone")))
    }),
  )

  it.effect("a file is not a git cwd; a symlink to a directory still is", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const repo = yield* makeRepository
      const file = path.join(yield* tempDirectory("vibest-file-"), "leaf")
      yield* fs.writeFileString(file, "x\n")
      assert.isUndefined(yield* gitState(file))
      assert.strictEqual((yield* Effect.flip(mainCheckout(file)))._tag, "NotInRepository")
      const fileLink = path.join(yield* tempDirectory("vibest-flink-"), "f")
      yield* fs.symlink(file, fileLink)
      assert.isUndefined(yield* gitState(fileLink))
      const link = path.join(yield* tempDirectory("vibest-dlink-"), "repo")
      yield* fs.symlink(repo, link)
      assert.strictEqual(yield* mainCheckout(link), yield* mainCheckout(repo))
      assert.ok(yield* gitState(link))
    }),
  )

  it.effect(
    "copyIncluded: .worktreeinclude matches that git ignores, by git's own rules; nothing else; repeatable; without it nothing is copied",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const repo = yield* makeRepository
        yield* write(`${repo}/tracked.txt`, "committed\n")
        yield* sh(repo, "add", "tracked.txt")
        yield* policy(
          repo,
          ".claude/settings.local.json\n.claude/worktrees/\n.env*\ncache/\nlogs/*\nodd*\n",
          "# local config\n.claude/\n.env.local\nCLAUDE.md\ncache/\n!cache/b\nlogs/*\n!logs/keep.log\ntracked.txt\nodd*\n",
        )
        yield* write(`${repo}/tracked.txt`, "edited in the main checkout\n")
        for (const f of [
          ".claude/settings.local.json",
          ".claude/notes.md",
          ".env.local",
          ".env.other",
          "cache/a",
          "cache/b",
          "logs/a.log",
          "logs/keep.log",
          "odd\nname",
          "odd name ",
        ])
          yield* write(`${repo}/${f}`, `${f}\n`)
        yield* sh(repo, "worktree", "add", "-q", "--detach", `${repo}/.claude/worktrees/sample`)
        yield* sh(repo, "init", "-q", `${repo}/.claude/nested`)
        yield* write(`${repo}/.claude/nested/f`, "n\n")
        const exclude = yield* fs.readFileString(`${repo}/.git/info/exclude`)

        const selected = [
          ".claude/settings.local.json",
          ".env.local",
          "cache/a",
          "cache/b",
          "logs/a.log",
          "odd\nname",
          "odd name ",
        ]
        const wt = yield* addWorktree(repo)
        assert.sameMembers(yield* copyIncluded(repo, wt), selected)
        for (const f of selected) assert.strictEqual(yield* fs.readFileString(`${wt}/${f}`), `${f}\n`)
        for (const f of [
          "CLAUDE.md",
          ".claude/notes.md",
          ".env.other",
          "logs/keep.log",
          ".claude/worktrees",
          ".claude/nested",
        ])
          assert.isFalse(yield* fs.exists(`${wt}/${f}`), f)
        assert.strictEqual(yield* fs.readFileString(`${wt}/tracked.txt`), "committed\n")
        assert.strictEqual(yield* sh(wt, "status", "--porcelain"), "")
        assert.strictEqual(yield* fs.readFileString(`${repo}/.git/info/exclude`), exclude)
        assert.deepStrictEqual(yield* copyIncluded(repo, wt), [])
        assert.sameMembers(yield* copyIncluded(repo, yield* addWorktree(repo)), selected)
        assert.strictEqual(yield* fs.readFileString(`${repo}/.git/info/exclude`), exclude)
        yield* fs.remove(`${repo}/.worktreeinclude`)
        const without = yield* addWorktree(repo)
        assert.deepStrictEqual(yield* copyIncluded(repo, without), [])
        for (const f of [".claude", ".env.local", "cache"]) assert.isFalse(yield* fs.exists(`${without}/${f}`), f)
      }),
  )

  it.effect("copyIncluded: only what git ignores both in the main checkout and in the new worktree is copied", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const repo = yield* makeRepository
      const files = ["committed.env", "shared.dat", "abs.dat", "local.env", "sub/secret.txt", "rel.dat", "inverse.env"]
      yield* policy(repo, "committed.env\ninverse.env\n", files.join("\n") + "\n")
      yield* fs.writeFileString(`${repo}/.gitignore`, "committed.env\nlocal.env\n")
      yield* write(`${repo}/sub/.gitignore`, "secret.txt\n")
      yield* write(`${repo}/rel-exclude`, "rel.dat\n")
      yield* sh(repo, "config", "core.excludesFile", "rel-exclude")
      yield* fs.writeFileString(
        `${repo}/.git/info/exclude`,
        (yield* fs.readFileString(`${repo}/.git/info/exclude`)) + "shared.dat\n",
      )
      for (const f of files) yield* write(`${repo}/${f}`, `${f}\n`)
      const wt = yield* addWorktree(repo)
      assert.sameMembers(yield* copyIncluded(repo, wt), ["committed.env", "shared.dat"])
      assert.strictEqual(yield* sh(wt, "status", "--porcelain", "--untracked-files=all"), "")
      const absoluteExcludes = `${yield* tempDirectory("vibest-excludes-")}/excludes`
      yield* fs.writeFileString(absoluteExcludes, "abs.dat\n")
      yield* sh(repo, "config", "core.excludesFile", absoluteExcludes)
      const wt2 = yield* addWorktree(repo)
      assert.sameMembers(yield* copyIncluded(repo, wt2), ["committed.env", "shared.dat", "abs.dat"])
      assert.strictEqual(yield* sh(wt2, "status", "--porcelain", "--untracked-files=all"), "")
    }),
  )
})
