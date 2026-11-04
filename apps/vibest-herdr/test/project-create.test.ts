// `vibest project create` and multi-repository worktrees: real git, temporary directories only.
import { assert, describe, it } from "@effect/vitest"
import { cliHeaders, connect } from "@vibest/client/client"
import { Db } from "@vibest/core/db"
import { Harness } from "@vibest/core/harness"
import * as Launch from "@vibest/core/launch"
import { Layout } from "@vibest/core/paths"
import { Project } from "@vibest/core/project"
import {
  createIsolatedWorktrees,
  createProject,
  listProjectRepositories,
  plainDirectoryKey,
  projectRepositories,
  projectRoot,
} from "@vibest/core/project-create"
import { Sessions } from "@vibest/core/sessions"
import { git, repositoryKey } from "@vibest/core/worktree"
import { sessionHeaders } from "@vibest/protocol/protocol"
import { KIND as RUNTIME } from "@vibest/runtime-herdr/terminal-runtime"
import * as Server from "@vibest/server/server"
import { Effect, Exit, Fiber, FileSystem, Layer, Option, Path, type Scope } from "effect"
import { TestClock } from "effect/testing"

import * as Platform from "#platform"

import { liveDaemon } from "../src/herdr-plugin.ts"
import { authed, FakeRuntime, runVibest, testLayer, type TestServices, until, writeResult } from "./fakes.ts"

// Not from fakes.ts: this suite needs no herdr, db or harness doubles.
const sh = (cwd: string, ...args: string[]) => git(cwd, ...args).pipe(Effect.orDie)

/** A real-path temp directory, removed with the scope. */
const tempDirectory = (prefix: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    return yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix }))
  }).pipe(Effect.orDie)

const test = <E>(
  name: string,
  program: Effect.Effect<void, E, Layer.Success<typeof Platform.services> | Scope.Scope>,
  timeout?: number,
) => {
  const run = () => program.pipe(Effect.provide(Platform.services))
  return timeout === undefined ? it.effect(name, run) : it.effect(name, run, timeout)
}

/** A repository at `<parent>/<name>` with one commit on `main`. */
const repository = (parent: string, name: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const root = path.join(parent, name)
    yield* fs.makeDirectory(root, { recursive: true })
    yield* sh(root, "init", "-q", "-b", "main")
    yield* sh(root, "config", "user.email", "t@example.com")
    yield* sh(root, "config", "user.name", "t")
    yield* fs.writeFileString(path.join(root, "README.md"), `${name}\n`)
    yield* sh(root, "add", ".")
    yield* sh(root, "commit", "-q", "-m", "init")
    return root
  }).pipe(Effect.orDie)

const failure = <A, E extends { message: string }, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(effect)
    if (Exit.isSuccess(exit)) return assert.fail("expected a failure")
    const error = exit.cause.reasons.find((r) => r._tag === "Fail")
    return error?._tag === "Fail" ? error.error.message : assert.fail(`not a failure: ${exit.cause}`)
  })

describe("project create", () => {
  test(
    "copies each repository as an independent clone on its branch, origin preserved, uncommitted changes reported",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const sources = yield* tempDirectory("vibest-sources-")
      const app = yield* repository(sources, "local-app")
      yield* sh(app, "remote", "add", "origin", "https://example.com/acme/app.git")
      yield* sh(app, "update-ref", "refs/remotes/origin/main", "HEAD")
      yield* sh(app, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main")
      yield* sh(app, "switch", "-q", "-c", "feature")
      yield* sh(app, "config", "branch.feature.remote", "origin")
      yield* sh(app, "config", "branch.feature.merge", "refs/heads/main")
      yield* fs.writeFileString(path.join(app, "README.md"), "edited\n")
      yield* fs.writeFileString(path.join(app, "new.txt"), "new\n")
      const sdk = yield* repository(sources, "sdk")

      const directory = path.join(yield* tempDirectory("vibest-project-"), "combo")
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
      // Its own objects: a loose object has one link (not hardlinked to the source's).
      const head = yield* sh(copy, "rev-parse", "HEAD")
      const object = path.join(copy, ".git/objects", head.slice(0, 2), head.slice(2))
      assert.strictEqual(Option.getOrUndefined((yield* fs.stat(object)).nlink), 1)

      const plain = path.join(directory, "sdk")
      assert.strictEqual(yield* sh(plain, "remote"), "")
      assert.strictEqual(yield* sh(plain, "branch", "--show-current"), "main")
      // The source is untouched.
      assert.strictEqual(yield* sh(app, "status", "--porcelain"), "M README.md\n?? new.txt")
    }),
  )

  test(
    "an existing empty directory is used; a non-empty one or a file is refused",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const sources = yield* tempDirectory("vibest-sources-")
      const app = yield* repository(sources, "app")
      const base = yield* tempDirectory("vibest-project-")
      const empty = path.join(base, "empty")
      yield* fs.makeDirectory(empty)
      assert.deepStrictEqual(
        (yield* createProject(empty, [app])).folders.map((f) => f.name),
        ["app"],
      )
      assert.match(yield* failure(createProject(empty, [app])), /exists and is not empty/)
      const file = path.join(base, "file")
      yield* fs.writeFileString(file, "x")
      assert.match(yield* failure(createProject(file, [app])), /exists and is not a directory/)
      assert.match(yield* failure(createProject(path.join(base, "missing/deep"), [app])), /does not exist/)
    }),
  )

  test(
    "refusals write nothing: not a git repository, a name collision, a detached HEAD, a directory inside a source",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const sources = yield* tempDirectory("vibest-sources-")
      const app = yield* repository(sources, "app")
      const otherApp = yield* repository(path.join(sources, "other"), "app")
      const plain = path.join(sources, "plain")
      yield* fs.makeDirectory(plain)
      const detached = yield* repository(sources, "detached")
      yield* sh(detached, "switch", "-q", "--detach")
      const directory = path.join(yield* tempDirectory("vibest-project-"), "combo")

      assert.match(yield* failure(createProject(directory, [app, plain])), /plain: not a git repository/)
      assert.match(yield* failure(createProject(directory, [app, otherApp])), /would both be the folder "app"/)
      assert.match(yield* failure(createProject(directory, [app, app])), /would both be the folder "app"/)
      assert.match(yield* failure(createProject(directory, [detached])), /HEAD is detached/)
      assert.match(yield* failure(createProject(directory, [path.join(sources, "missing")])), /not found/)
      assert.match(yield* failure(createProject(directory, [])), /at least one/)
      assert.isFalse(yield* fs.exists(directory))
      assert.match(yield* failure(createProject(path.join(app, "combo"), [app])), /would be inside this repository/)
      assert.isFalse(yield* fs.exists(path.join(app, "combo")))
    }),
  )

  test(
    "a failed copy removes only what the call created",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const sources = yield* tempDirectory("vibest-sources-")
      const app = yield* repository(sources, "app")
      // Unborn branch: inspection passes, the clone of `main` fails.
      const unborn = path.join(sources, "unborn")
      yield* fs.makeDirectory(unborn)
      yield* sh(unborn, "init", "-q", "-b", "main")
      const base = yield* tempDirectory("vibest-project-")

      const fresh = path.join(base, "fresh")
      assert.match(yield* failure(createProject(fresh, [app, unborn])), /copy .*unborn/)
      assert.isFalse(yield* fs.exists(fresh))

      const kept = path.join(base, "kept")
      yield* fs.makeDirectory(kept)
      assert.match(yield* failure(createProject(kept, [app, unborn])), /copy .*unborn/)
      assert.deepStrictEqual(yield* fs.readDirectory(kept), [])
    }),
  )

  test(
    "an interrupt removes only what the call created",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const sources = yield* tempDirectory("vibest-sources-")
      const app = yield* repository(sources, "app")
      // Checkout of the clone runs smudge and waits, so the interrupt lands while the directory exists. clean is cat, so adding the attribute does not wait.
      // A clone does not copy the source's config, so the filter comes from the environment of every git this test runs.
      const slow = { "filter.slow.clean": "cat", "filter.slow.smudge": "sleep 30", "filter.slow.required": "true" }
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          process.env.GIT_CONFIG_COUNT = String(Object.keys(slow).length)
          Object.entries(slow).forEach(([key, value], i) => {
            process.env[`GIT_CONFIG_KEY_${i}`] = key
            process.env[`GIT_CONFIG_VALUE_${i}`] = value
          })
        }),
        () =>
          Effect.sync(() => {
            delete process.env.GIT_CONFIG_COUNT
            Object.keys(slow).forEach((_, i) => {
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

      const fresh = path.join(yield* tempDirectory("vibest-project-"), "fresh")
      const created = yield* Effect.forkChild(createProject(fresh, [app]))
      yield* waitFor(path.join(fresh, "app"))
      yield* Fiber.interrupt(created)
      assert.isTrue(Exit.hasInterrupts(yield* Fiber.await(created)))
      assert.isFalse(yield* fs.exists(fresh))

      const kept = path.join(yield* tempDirectory("vibest-project-"), "kept")
      yield* fs.makeDirectory(kept)
      const into = yield* Effect.forkChild(createProject(kept, [app]))
      yield* waitFor(path.join(kept, "app"))
      yield* Fiber.interrupt(into)
      assert.isTrue(Exit.hasInterrupts(yield* Fiber.await(into)))
      assert.isTrue(yield* fs.exists(kept))
      assert.deepStrictEqual(yield* fs.readDirectory(kept), [])

      const root = path.join(yield* tempDirectory("vibest-multi-"), "combo")
      yield* fs.makeDirectory(root)
      yield* fs.rename(app, path.join(root, "app"))
      const folders = (yield* listProjectRepositories(root))!
      const workspace = path.join(path.dirname(root), "ws")
      const trees = yield* Effect.forkChild(createIsolatedWorktrees(folders, workspace))
      yield* waitFor(path.join(workspace, "app"))
      yield* Fiber.interrupt(trees)
      assert.isTrue(Exit.hasInterrupts(yield* Fiber.await(trees)))
      assert.isFalse(yield* fs.exists(workspace))
      // Detached: no branch was ever created.
      assert.strictEqual(yield* sh(path.join(root, "app"), "branch", "--list", "vibest/*"), "")
    }),
    20_000,
  )
})

describe("multi-repository project", () => {
  test(
    "a project is multi-repository only when the directory itself is not a git repository and a direct child is",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const parent = yield* tempDirectory("vibest-multi-")
      const root = path.join(parent, "combo")
      yield* fs.makeDirectory(root)
      const app = yield* repository(root, "app")
      yield* repository(root, "sdk")
      yield* fs.makeDirectory(path.join(root, "notes"))
      assert.deepStrictEqual(
        (yield* listProjectRepositories(root))?.map((r) => r.name),
        ["app", "sdk"],
      )
      assert.isUndefined(yield* listProjectRepositories(app))
      const nested = yield* repository(app, "nested")
      assert.isUndefined(yield* listProjectRepositories(app))
      const sub = path.join(app, "src")
      yield* fs.makeDirectory(sub)
      yield* fs.rename(nested, path.join(sub, "nested"))
      assert.isUndefined(yield* listProjectRepositories(sub))
      assert.isUndefined(yield* listProjectRepositories(path.join(parent, "empty")))
    }),
  )

  test(
    "projectRoot is the directory of a multi-repository project and the main checkout otherwise",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const parent = yield* tempDirectory("vibest-root-")
      const root = path.join(parent, "combo")
      yield* fs.makeDirectory(root)
      const app = yield* repository(root, "app")
      yield* repository(root, "sdk")
      const multi = yield* projectRoot(root)
      assert.strictEqual(multi.root, root)
      assert.strictEqual(multi.key, yield* plainDirectoryKey(root))
      const single = yield* projectRoot(app)
      assert.strictEqual(single.root, app)
      assert.strictEqual(single.key, yield* repositoryKey(app))
      const sub = path.join(app, "src")
      yield* fs.makeDirectory(sub)
      const inside = yield* projectRoot(sub)
      assert.strictEqual(inside.root, app)
      assert.strictEqual(inside.key, single.key)
      // Each repository by its main checkout's realpath, with origin as git prints it; through a symlink too.
      yield* sh(app, "remote", "add", "origin", "git@github.com:O/App.git")
      const link = path.join(parent, "link")
      yield* fs.symlink(root, link)
      for (const at of [root, link])
        assert.deepStrictEqual(yield* projectRepositories(at), [
          { path: app, remote: "git@github.com:O/App.git" },
          { path: path.join(root, "sdk"), remote: undefined },
        ])
      assert.deepStrictEqual(yield* projectRepositories(path.join(link, "app")), [
        { path: app, remote: "git@github.com:O/App.git" },
      ])
    }),
  )

  test(
    "isolated worktrees are created detached, with no branch left behind",
    Effect.gen(function* () {
      const path = yield* Path.Path
      const parent = yield* tempDirectory("vibest-multi-")
      const root = path.join(parent, "combo")
      const fs = yield* FileSystem.FileSystem
      yield* fs.makeDirectory(root)
      yield* repository(root, "app")
      yield* repository(root, "sdk")
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
      // A workspace of linked worktrees is not a second Project.
      const fromWorkspace = yield* projectRoot(workspace)
      assert.strictEqual(fromWorkspace.root, root)
      assert.strictEqual(fromWorkspace.key, yield* plainDirectoryKey(root))
      assert.notStrictEqual(fromWorkspace.key, yield* plainDirectoryKey(workspace))
    }),
  )

  test(
    "a failed copy removes the worktrees this call created; a leftover branch name never blocks it",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const parent = yield* tempDirectory("vibest-multi-")
      const root = path.join(parent, "combo")
      yield* fs.makeDirectory(root)
      const app = yield* repository(root, "app")
      const sdk = yield* repository(root, "sdk")
      // A stale branch from an earlier vibest: this call takes no branch name, so it cannot clash.
      yield* sh(sdk, "branch", "vibest/ab12")
      const kept = yield* sh(sdk, "rev-parse", "refs/heads/vibest/ab12")
      // cfg is a tracked file, a directory in the folder only: the worktree's cfg cannot hold cfg/x.
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

  test(
    "vibest project create prints the project as JSON, warns about uncommitted changes, and does not need vibestd",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const home = yield* tempDirectory("vibest-home-")
      const sources = yield* tempDirectory("vibest-sources-")
      const app = yield* repository(sources, "app")
      yield* fs.writeFileString(path.join(app, "README.md"), "edited\n")
      const sdk = yield* repository(sources, "sdk")
      const directory = path.join(yield* tempDirectory("vibest-project-"), "combo")
      const env = { HOME: home, VIBEST_HOME: home }
      const created = yield* runVibest(sources, env, ["project", "create", directory, "--from", app, "--from", sdk])
      assert.strictEqual(created.code, 0, created.stderr)
      assert.match(created.stderr, new RegExp(`warning: ${app}: uncommitted changes were not copied`))
      assert.match(created.stderr, /M README\.md/)
      assert.notMatch(created.stderr, /sdk/)
      const project = JSON.parse(created.stdout) as {
        directory: string
        folders: ReadonlyArray<{ name: string; uncommitted: ReadonlyArray<string> }>
      }
      assert.strictEqual(project.directory, directory)
      assert.deepStrictEqual(
        project.folders.map((f) => f.name),
        ["app", "sdk"],
      )
      assert.deepStrictEqual(project.folders[0]!.uncommitted, [" M README.md"])
      assert.isFalse(yield* fs.exists(path.join(home, "vibest.sock")))

      const again = path.join(directory, "nope")
      const agent = yield* runVibest(sources, { ...env, VIBEST_SESSION_ID: "abcd1234-abcd-4abc-8abc-abcd1234abcd" }, [
        "project",
        "create",
        again,
        "--from",
        sdk,
      ])
      assert.strictEqual(agent.code, 1)
      assert.match(agent.stderr, /^Forbidden: /)
      assert.isFalse(yield* fs.exists(again))

      const usage = yield* runVibest(sources, env, ["project", "create", path.join(directory, "missing")])
      assert.strictEqual(usage.code, 2)
      const bad = yield* runVibest(sources, env, [
        "project",
        "create",
        path.join(directory, "bad"),
        "--from",
        path.join(sources, "nope"),
      ])
      assert.strictEqual(bad.code, 1)
      assert.match(bad.stderr, /^ProjectCreateFailed: /)
    }),
    30_000,
  )
})

const served = Server.layer.pipe(
  Layer.provide(Layer.unwrap(Effect.map(Layout, (layout) => Platform.daemon.socketServer(layout.socket)))),
  Layer.provideMerge(Project.layer),
  Layer.provideMerge(testLayer()),
)

const sessionTest = <E>(name: string, program: Effect.Effect<void, E, TestServices | Project | Scope.Scope>) =>
  it.effect(name, () => program.pipe(Effect.provide(served)), 30_000)

describe("multi-repository isolated workspace", () => {
  sessionTest(
    "a writing subagent gets one detached worktree per repository; archive removes each that is safe; the result names branch and pushed per repository",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const db = yield* Db
      const herdr = yield* FakeRuntime
      const sessions = yield* Sessions
      const parent = yield* tempDirectory("vibest-multi-")
      const root = path.join(parent, "combo")
      yield* fs.makeDirectory(root)
      const app = yield* repository(root, "app")
      const sdk = yield* repository(root, "sdk")
      yield* db.coordinatorLaunch(yield* plainDirectoryKey(root), "pi", false, {
        runtime: RUNTIME,
        address: { machine: "local", id: "test/coord" },
      })

      const { id } = yield* sessions.spawn({
        machine: { id: "local" },
        root,
        key: yield* plainDirectoryKey(root),
        name: "task",
        prompt: "do it",
        harness: "pi",
      })
      yield* until(db.getSession(id), (w) => !!w && (w.startedAt !== null || w.exitedAt !== null))
      yield* sessions.check(id)
      const row = (yield* db.getSession(id))!
      const workspace = (yield* db.sessionDirectory(row.id))!
      assert.strictEqual(path.basename(path.dirname(workspace)), "combo")
      const appWt = path.join(workspace, "app")
      const sdkWt = path.join(workspace, "sdk")
      assert.strictEqual(yield* sh(appWt, "branch", "--show-current"), "")
      assert.strictEqual(yield* sh(sdkWt, "branch", "--show-current"), "")
      assert.strictEqual(yield* sh(app, "branch", "--list", "vibest/*"), "")
      assert.strictEqual(yield* sh(sdk, "branch", "--list", "vibest/*"), "")
      // Placed like any session, from the project directory.
      assert.deepStrictEqual(
        (yield* herdr.callsTo("open")).map((call) => [call.project, call.cwd]),
        [[root, workspace]],
      )

      const view = yield* sessions.get(id)
      assert.strictEqual(view.git?.branch, "app=\nsdk=")
      assert.strictEqual(view.git?.pushed, false)
      assert.strictEqual(view.git?.saved, true)

      yield* writeResult(id, "pi", { text: "status: completed" })
      yield* herdr.endTurn(id)
      yield* sessions.check(id)
      const message = (yield* db.latestInbox(id, "result"))!.message
      assert.include(message, "<branch>app=\nsdk=</branch>")
      assert.include(message, "<pushed>app=false\nsdk=false</pushed>")

      yield* sh(sdkWt, "switch", "-q", "-c", "feat/sdk")
      yield* fs.writeFileString(path.join(appWt, "README.md"), "changed\n")
      const kept = (yield* sessions.remove(id))!
      assert.strictEqual(kept.worktree, "kept")
      assert.match(kept.reasons.join("\n"), /app: worktree kept: uncommitted changes/)
      assert.strictEqual(kept.branch, "sdk=feat/sdk")
      assert.isTrue(yield* fs.exists(appWt))
      assert.isFalse(yield* fs.exists(sdkWt))
      assert.strictEqual(yield* sh(sdk, "branch", "--list", "feat/sdk"), "feat/sdk")

      yield* sh(appWt, "checkout", "--", "README.md")
      const removed = (yield* sessions.remove(id))!
      assert.strictEqual(removed.worktree, "removed")
      assert.isFalse(yield* fs.exists(workspace))
    }),
  )

  sessionTest(
    "vibest run from the project directory is the same workspace",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const db = yield* Db
      const layout = yield* Layout
      const parent = yield* tempDirectory("vibest-multi-")
      const root = path.join(parent, "combo")
      yield* fs.makeDirectory(root)
      yield* repository(root, "app")
      yield* repository(root, "sdk")
      const spawned = yield* runVibest(root, { HOME: layout.home, VIBEST_HOME: layout.home }, [
        "run",
        "pi",
        "--",
        "do it",
      ])
      assert.strictEqual(spawned.code, 0, spawned.stderr)
      const { id } = JSON.parse(spawned.stdout) as { id: string }
      yield* until(db.getSession(id), (w) => !!w && (w.startedAt !== null || w.exitedAt !== null))
      const row = (yield* db.getSession(id))!
      const workspace = (yield* db.sessionDirectory(row.id))!
      assert.strictEqual(path.basename(path.dirname(workspace)), "combo")
      assert.strictEqual(yield* sh(path.join(workspace, "app"), "rev-parse", "--is-inside-work-tree"), "true")
      assert.strictEqual(yield* sh(path.join(workspace, "sdk"), "branch", "--show-current"), "")
    }),
  )

  sessionTest(
    "vibest in a multi-repository project starts the main agent",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const db = yield* Db
      const parent = yield* tempDirectory("vibest-multi-")
      const root = path.join(parent, "combo")
      yield* fs.makeDirectory(root)
      yield* repository(root, "app")
      yield* repository(root, "sdk")
      const raw = yield* connect((yield* Layout).socket)
      const command = yield* Launch.coordinatorCommand({
        harness: "pi",
        root,
        provider: null,
        model: null,
        passEnv: [],
        session: authed(raw, cliHeaders(root))["Project.CoordinatorSession"]({
          harness: "pi",
          fresh: false,
          terminal: "home:p1",
        }),
      }).pipe(
        Effect.provide(
          Layer.succeed(Harness, {
            available: () => Effect.succeed(true),
            plugin: (id) => Effect.succeed(`/vibest/harnesses/${id}`),
            models: () => Effect.succeed([]),
          }),
        ),
      )
      assert.strictEqual(command.env.VIBEST_AGENT, "coordinator")
      const main = yield* db.coordinatorOf(yield* db.projectId(yield* plainDirectoryKey(root)))
      assert.strictEqual(main?.projectDirectory, root)
      assert.notStrictEqual(main?.directory, root)
    }),
  )

  sessionTest(
    "the main agent of a multi-repository project starts a session from inside one of its repositories",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const db = yield* Db
      const layout = yield* Layout
      const parent = yield* tempDirectory("vibest-multi-")
      const root = path.join(parent, "combo")
      yield* fs.makeDirectory(root)
      const app = yield* repository(root, "app")
      yield* repository(root, "sdk")
      const raw = yield* connect(layout.socket)
      const { sessionId, projectId } = yield* authed(raw, cliHeaders(root))["Project.CoordinatorSession"]({
        harness: "pi",
        fresh: false,
        terminal: "coord",
      })
      const { id } = yield* authed(
        raw,
        sessionHeaders({ sessionId, repositoryRoot: app, projectId: String(projectId) }),
      ).Spawn({
        harness: "pi",
        prompt: "do it",
      })
      yield* until(db.getSession(id), (row) => !!row && (row.startedAt !== null || row.exitedAt !== null))
      const row = (yield* db.getSession(id))!
      assert.strictEqual(yield* db.projectKey(row.projectId), yield* plainDirectoryKey(root))
      const workspace = (yield* db.sessionDirectory(row.id))!
      assert.isTrue(yield* fs.exists(path.join(workspace, "app")))
      assert.isTrue(yield* fs.exists(path.join(workspace, "sdk")))
    }),
  )

  sessionTest(
    "resume after the main pane is gone uses the project path, and herdr runs lists that project",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const db = yield* Db
      const herdr = yield* FakeRuntime
      const sessions = yield* Sessions
      const parent = yield* tempDirectory("vibest-multi-")
      const root = path.join(parent, "combo")
      yield* fs.makeDirectory(root)
      yield* repository(root, "app")
      yield* repository(root, "sdk")
      const workspace = path.join(parent, "ws")
      yield* createIsolatedWorktrees((yield* listProjectRepositories(root))!, workspace)
      const raw = yield* connect((yield* Layout).socket)
      const cli = authed(raw, cliHeaders(root))
      yield* cli["Project.CoordinatorSession"]({ harness: "pi", fresh: false, terminal: "coord" })
      const { id } = yield* authed(raw, cliHeaders(workspace)).Spawn({ harness: "pi", prompt: "do it" })
      yield* until(db.getSession(id), (row) => row?.turnState === "open")
      const key = yield* plainDirectoryKey(root)
      assert.strictEqual(yield* db.projectKey((yield* db.getSession(id))!.projectId), key)
      assert.notStrictEqual(key, yield* plainDirectoryKey(workspace))
      assert.strictEqual((yield* herdr.callsTo("open"))[0]!.project, root)

      const listed = yield* liveDaemon().list(workspace)
      assert.deepStrictEqual(listed.map((session) => session.agent).sort(), ["general", "main"])
      assert.deepStrictEqual(
        (yield* liveDaemon().list(root)).map((session) => session.id).sort(),
        listed.map((session) => session.id).sort(),
      )

      yield* writeResult(id, "pi", { text: "status: completed" })
      yield* herdr.endTurn(id)
      yield* sessions.check(id)
      yield* herdr.updateAgent(id, (agent) => ({ ...agent, alive: false }))
      const before = (yield* herdr.callsTo("open")).length
      yield* sessions.send(id, "again")
      const places = yield* until(herdr.callsTo("open"), (calls) => calls.length > before)
      assert.strictEqual(places.at(-1)!.project, root)
      assert.notStrictEqual(places.at(-1)!.project, key)
      assert.strictEqual((yield* herdr.callsTo("present")).at(-1)!.info.project, "combo")
    }),
  )
})
