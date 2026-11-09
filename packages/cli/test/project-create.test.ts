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
  projectRepositories,
  projectRoot,
} from "@vibest/core/project-create"
import { Sessions } from "@vibest/core/sessions"
import { sessionHeaders } from "@vibest/protocol/protocol"
import { KIND as RUNTIME } from "@vibest/runtime-herdr/terminal-runtime"
import * as Server from "@vibest/server/server"
import { Effect, Exit, FileSystem, Layer, Path, type Scope } from "effect"

import * as Platform from "#platform"

import { liveDaemon } from "../src/herdr-plugin.ts"
import {
  authed,
  FakeGit,
  FakeRuntime,
  runVibest,
  testLayer,
  type TestServices,
  until,
  writeResult,
  projectOf,
} from "./fakes.ts"

const scopedRealPathTempDirectory = (prefix: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    return yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix }))
  }).pipe(Effect.orDie)

const test = <E>(
  name: string,
  program: Effect.Effect<
    void,
    E,
    Layer.Success<typeof Platform.services> | Layer.Success<typeof FakeGit.layers> | Scope.Scope
  >,
  timeout?: number,
) => {
  const run = () => program.pipe(Effect.provide(FakeGit.layers.pipe(Layer.provideMerge(Platform.services))))
  return timeout === undefined ? it.effect(name, run) : it.effect(name, run, timeout)
}

const repositoryWithOneCommitOnMain = (parent: string, name: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const root = path.join(parent, name)
    yield* fs.makeDirectory(root, { recursive: true })
    yield* fs.writeFileString(path.join(root, "README.md"), `${name}\n`)
    yield* (yield* FakeGit).repository(root)
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
    "an existing empty directory is used; a non-empty one or a file is refused",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const sources = yield* scopedRealPathTempDirectory("vibest-sources-")
      const app = yield* repositoryWithOneCommitOnMain(sources, "app")
      const base = yield* scopedRealPathTempDirectory("vibest-project-")
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
      const sources = yield* scopedRealPathTempDirectory("vibest-sources-")
      const app = yield* repositoryWithOneCommitOnMain(sources, "app")
      const otherApp = yield* repositoryWithOneCommitOnMain(path.join(sources, "other"), "app")
      const plain = path.join(sources, "plain")
      yield* fs.makeDirectory(plain)
      const detached = yield* repositoryWithOneCommitOnMain(sources, "detached")
      yield* (yield* FakeGit).update(detached, { branch: "" })
      const directory = path.join(yield* scopedRealPathTempDirectory("vibest-project-"), "combo")

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
})

describe("multi-repository project", () => {
  test(
    "a project is multi-repository only when the directory itself is not a git repository and a direct child is",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const parent = yield* scopedRealPathTempDirectory("vibest-multi-")
      const root = path.join(parent, "combo")
      yield* fs.makeDirectory(root)
      const app = yield* repositoryWithOneCommitOnMain(root, "app")
      yield* repositoryWithOneCommitOnMain(root, "sdk")
      yield* fs.makeDirectory(path.join(root, "notes"))
      assert.deepStrictEqual(
        (yield* listProjectRepositories(root))?.map((r) => r.name),
        ["app", "sdk"],
      )
      assert.isUndefined(yield* listProjectRepositories(app))
      const nested = yield* repositoryWithOneCommitOnMain(app, "nested")
      assert.isUndefined(yield* listProjectRepositories(app))
      const sub = path.join(app, "src")
      yield* fs.makeDirectory(sub)
      yield* fs.rename(nested, path.join(sub, "nested"))
      assert.isUndefined(yield* listProjectRepositories(sub))
      assert.isUndefined(yield* listProjectRepositories(path.join(parent, "empty")))
    }),
  )

  test(
    "projectRoot is the directory of a multi-repository project and the main checkout otherwise; projectRepositories lists each by its main checkout's realpath with origin as git prints it, through a symlink too",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const parent = yield* scopedRealPathTempDirectory("vibest-root-")
      const root = path.join(parent, "combo")
      yield* fs.makeDirectory(root)
      const app = yield* repositoryWithOneCommitOnMain(root, "app")
      yield* repositoryWithOneCommitOnMain(root, "sdk")
      const multi = yield* projectRoot(root)
      assert.strictEqual(multi.root, root)
      const single = yield* projectRoot(app)
      assert.strictEqual(single.root, app)
      const sub = path.join(app, "src")
      yield* fs.makeDirectory(sub)
      const inside = yield* projectRoot(sub)
      assert.strictEqual(inside.root, app)
      yield* (yield* FakeGit).update(app, { origin: "git@github.com:O/App.git" })
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
    "vibest project create prints the project as JSON and warns about uncommitted changes",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const home = (yield* Layout).home
      const sources = yield* scopedRealPathTempDirectory("vibest-sources-")
      const app = yield* repositoryWithOneCommitOnMain(sources, "app")
      yield* (yield* FakeGit).update(app, { uncommitted: [" M README.md"] })
      const sdk = yield* repositoryWithOneCommitOnMain(sources, "sdk")
      const directory = path.join(yield* scopedRealPathTempDirectory("vibest-project-"), "combo")
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
  )

  sessionTest(
    "vibest run from the project directory: a writing subagent gets one detached worktree per repository; archive removes each that is safe; the result names branch and pushed per repository",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const db = yield* Db
      const layout = yield* Layout
      const herdr = yield* FakeRuntime
      const sessions = yield* Sessions
      const parent = yield* scopedRealPathTempDirectory("vibest-multi-")
      const root = path.join(parent, "combo")
      yield* fs.makeDirectory(root)
      const app = yield* repositoryWithOneCommitOnMain(root, "app")
      const sdk = yield* repositoryWithOneCommitOnMain(root, "sdk")
      yield* db.coordinatorLaunch(yield* projectOf(root), "pi", false, {
        runtime: RUNTIME,
        address: { machine: "local", id: "test/coord" },
      })

      const spawned = yield* runVibest(root, { HOME: layout.home, VIBEST_HOME: layout.home }, [
        "run",
        "--runtime",
        "herdr",
        "pi",
        "--",
        "do it",
      ])
      assert.strictEqual(spawned.code, 0, spawned.stderr)
      const { id } = JSON.parse(spawned.stdout) as { id: string }
      yield* until(db.getSession(id), (w) => !!w && (w.startedAt !== null || w.exitedAt !== null))
      yield* sessions.check(id)
      const row = (yield* db.getSession(id))!
      const workspace = (yield* db.sessionDirectory(row.id))!
      assert.strictEqual(path.basename(path.dirname(workspace)), "combo")
      const appWt = path.join(workspace, "app")
      const sdkWt = path.join(workspace, "sdk")
      const fakeGit = yield* FakeGit
      assert.deepStrictEqual(yield* fakeGit.git.linkedWorktrees(app), [appWt])
      assert.deepStrictEqual(yield* fakeGit.git.linkedWorktrees(sdk), [sdkWt])
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

      yield* fakeGit.checkout(sdkWt, { state: { branch: "feat/sdk", pushed: false, saved: true, why: "" } })
      yield* fakeGit.checkout(appWt, { state: { branch: "", pushed: false, saved: false, why: "uncommitted changes" } })
      const kept = (yield* sessions.remove(id))!
      assert.strictEqual(kept.worktree, "kept")
      assert.match(kept.reasons.join("\n"), /app: worktree kept: uncommitted changes/)
      assert.strictEqual(kept.branch, "sdk=feat/sdk")
      assert.isTrue(yield* fs.exists(appWt))
      assert.isFalse(yield* fs.exists(sdkWt))

      yield* fakeGit.checkout(appWt, { state: { branch: "", pushed: false, saved: true, why: "" } })
      const removed = (yield* sessions.remove(id))!
      assert.strictEqual(removed.worktree, "removed")
      assert.isFalse(yield* fs.exists(workspace))
    }),
  )

  sessionTest(
    "vibest in a multi-repository project starts the main agent",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const db = yield* Db
      const parent = yield* scopedRealPathTempDirectory("vibest-multi-")
      const root = path.join(parent, "combo")
      yield* fs.makeDirectory(root)
      yield* repositoryWithOneCommitOnMain(root, "app")
      yield* repositoryWithOneCommitOnMain(root, "sdk")
      const raw = yield* connect((yield* Layout).socket)
      const command = yield* Launch.coordinatorCommand({
        harness: "pi",
        root,
        provider: null,
        model: null,
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
      const main = yield* db.coordinatorOf(yield* projectOf(root))
      assert.strictEqual(main?.projectDirectory, root)
    }),
  )

  sessionTest(
    "the main agent of a multi-repository project starts a session from inside one of its repositories",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const db = yield* Db
      const layout = yield* Layout
      const parent = yield* scopedRealPathTempDirectory("vibest-multi-")
      const root = path.join(parent, "combo")
      yield* fs.makeDirectory(root)
      const app = yield* repositoryWithOneCommitOnMain(root, "app")
      yield* repositoryWithOneCommitOnMain(root, "sdk")
      const raw = yield* connect(layout.socket)
      const { sessionId, projectId } = yield* authed(raw, cliHeaders(root))["Project.CoordinatorSession"]({
        harness: "pi",
        fresh: false,
        terminal: "coord",
      })
      const { id } = yield* authed(
        raw,
        sessionHeaders({ sessionId, repositoryRoot: app, projectId: String(projectId) }),
      ).Spawn({ callerEnv: {}, harness: "pi", prompt: "do it" })
      yield* until(db.getSession(id), (row) => !!row && (row.startedAt !== null || row.exitedAt !== null))
      const row = (yield* db.getSession(id))!
      assert.strictEqual(row.projectId, (yield* db.projectAt(root))?.id)
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
      const parent = yield* scopedRealPathTempDirectory("vibest-multi-")
      const root = path.join(parent, "combo")
      yield* fs.makeDirectory(root)
      yield* repositoryWithOneCommitOnMain(root, "app")
      yield* repositoryWithOneCommitOnMain(root, "sdk")
      const workspace = path.join(parent, "ws")
      yield* createIsolatedWorktrees((yield* listProjectRepositories(root))!, workspace)
      const raw = yield* connect((yield* Layout).socket)
      const cli = authed(raw, cliHeaders(root))
      yield* cli["Project.CoordinatorSession"]({ harness: "pi", fresh: false, terminal: "coord" })
      const { id } = yield* authed(raw, cliHeaders(workspace)).Spawn({ callerEnv: {}, harness: "pi", prompt: "do it" })
      yield* until(db.getSession(id), (row) => row?.turnState === "open")
      assert.strictEqual((yield* db.getSession(id))!.projectId, (yield* db.projectAt(root))?.id)
      assert.isUndefined(yield* db.projectAt(workspace))
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
      yield* sessions.check(id)
      yield* until(db.getSession(id), (row) => row?.exitedAt != null)
      const before = (yield* herdr.callsTo("open")).length
      yield* sessions.send(id, "again")
      const places = yield* until(herdr.callsTo("open"), (calls) => calls.length > before)
      assert.strictEqual(places.at(-1)!.project, root)
      assert.strictEqual((yield* herdr.callsTo("present")).at(-1)!.info.project, "combo")
    }),
  )
})
