import { assert, describe } from "@effect/vitest"
import { Db } from "@vibest/core/database/db"
import { projectRoot } from "@vibest/core/project/create"
import { FakeRuntime, makeRepository, until, projectOf } from "@vibest/platform-bun/test/lib/fakes"
import { test, client, asCli, asEntry } from "@vibest/platform-bun/test/lib/rpc-helpers"
import { Plugin } from "@vibest/plugin/effect"
import { Effect, Fiber, FileSystem, Predicate, Ref } from "effect"
import { SqlClient } from "effect/sql"

describe("vibest.sock", () => {
  const seenDirectory = { project: "" }
  test(
    "Session.Claim schedules with the project directory, not its key; with no harness it fails until a root session exists, then takes its harness",
    Effect.gen(function* () {
      const repo = yield* makeRepository
      const c = asCli(yield* client, repo)

      const first = yield* Effect.flip(
        c["Session.Claim"]({ agent: "general", runtime: "herdr", fresh: false, terminal: "test/p1" }),
      )

      assert.strictEqual(first._tag, "LaunchFailed")
      assert.match(first.message, /no harness to inherit/)

      const claimed = yield* c["Session.Claim"]({
        agent: "coordinator",
        runtime: "herdr",
        harness: "claude",
        fresh: false,
        terminal: "test/p1",
      })

      assert.strictEqual(seenDirectory.project, (yield* projectRoot(repo)).root)
      assert.notStrictEqual(seenDirectory.project, yield* projectOf(repo))

      const resumed = yield* c["Session.Claim"]({
        agent: "coordinator",
        runtime: "herdr",
        fresh: false,
        terminal: "test/p1",
      })

      assert.strictEqual(resumed.sessionId, claimed.sessionId)
    }),
    {
      plugins: [
        Plugin.define({
          id: "see",
          effect: (ctx) =>
            ctx.agent.hook("start.before", (e) =>
              Effect.sync(() => {
                seenDirectory.project = e.project
              }),
            ),
        }),
      ],
    },
  )

  test(
    "List shows the root session's live status from its pane, not a stored unknown",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const repo = yield* makeRepository
      const c = asCli(yield* client, repo)
      const pane = "w1:coord"
      yield* herdr.seedAgent(pane)
      yield* c["Session.Claim"]({ agent: "coordinator", harness: "pi", fresh: false, terminal: pane })
      yield* herdr.updateAgent(pane, (a) => ({ ...a, status: "working" }))
      yield* until(c.List({}), (list) => list.sessions[0]?.status === "working")
      assert.deepInclude((yield* c.List({})).sessions[0], { agent: "coordinator", status: "working" })
      yield* herdr.updateAgent(pane, (a) => ({ ...a, status: "idle" }))
      yield* until(c.List({}), (list) => list.sessions[0]?.status === "idle")
      assert.deepInclude((yield* c.List({})).sessions[0], { agent: "coordinator", status: "idle" })
    }),
    { statusEvents: true },
  )

  test(
    "Archive names the resolved session when the runtime is unreachable, not the prefix typed",
    Effect.gen(function* () {
      const db = yield* Db.Service
      const herdr = yield* FakeRuntime
      const repo = yield* makeRepository
      const c = asCli(yield* client, repo)
      const spawner = yield* asEntry(yield* client, repo)
      const { id } = yield* spawner.Spawn({ agent: "general", callerEnv: {}, harness: "pi", prompt: "do it" })
      yield* until(
        db.session.getSession(id),
        (row) => (row?.process?.placedAt ?? null) !== null && row?.status === "working",
      )
      yield* Ref.set(herdr.reachable, false)
      const failed = yield* Effect.flip(c.Archive({ id: id.slice(0, 8) }))
      assert.strictEqual(failed._tag, "RuntimeUnreachable")
      assert.strictEqual("session" in failed ? failed.session : failed._tag, id)
    }),
  )

  test(
    "archive archives a root session and leaves its checkout directory untouched",
    Effect.gen(function* () {
      const db = yield* Db.Service
      const fs = yield* FileSystem.FileSystem
      const repo = yield* makeRepository
      const projectId = yield* projectOf(repo)

      const started = yield* db.session.startRoot(
        projectId,
        "pi",
        false,
        {
          runtime: "herdr",
          address: { machine: "local", id: "test/main" },
        },
        { agent: "coordinator", projectDirectory: repo },
      )

      const outcome = yield* asCli(yield* client, repo).Archive({ id: started.sessionId })
      assert.isNotNull(outcome)
      assert.strictEqual(outcome?.worktree, "kept")
      assert.isTrue(yield* fs.exists(repo))
      assert.isNotNull((yield* db.session.getSession(started.sessionId))?.endedAt)
    }),
  )

  test(
    "--new with a missing harness does not archive the current root session",
    Effect.gen(function* () {
      const db = yield* Db.Service
      const repo = yield* makeRepository
      const projectId = yield* projectOf(repo)
      yield* db.session.startRoot(
        projectId,
        "pi",
        false,
        {
          runtime: "herdr",
          address: { machine: "local", id: "test/main" },
        },
        { agent: "coordinator" },
      )
      const before = (yield* db.session.latestRoot(projectId))!.id

      const failed = yield* Effect.flip(
        asCli(yield* client, repo).Launch({
          agent: "coordinator",
          callerEnv: {},
          harness: "cursor",
          fresh: true,
          focus: false,
          runtime: "herdr",
        }),
      )

      assert.ok(Predicate.isTagged(failed, "LaunchFailed") || Predicate.isTagged(failed, "AgentRefused"), failed._tag)
      assert.strictEqual((yield* db.session.latestRoot(projectId))!.id, before)
    }),
    { missingBinary: ["cursor"] },
  )

  test(
    "a root launch whose typing fails leaves no open execution: the next start runs its first input",
    Effect.gen(function* () {
      const db = yield* Db.Service
      const sql = yield* SqlClient.SqlClient
      const herdr = yield* FakeRuntime
      const repo = yield* makeRepository
      const projectId = yield* projectOf(repo)

      const launch = Effect.flatMap(client, (c) =>
        asCli(c, repo).Launch({
          agent: "coordinator",
          callerEnv: {},
          harness: "cursor",
          focus: false,
          runtime: "herdr",
        }),
      )

      const held = yield* herdr.hold("run")
      const failing = yield* Effect.forkChild(Effect.flip(launch))
      yield* held.reached
      yield* held.release("failed")
      assert.strictEqual((yield* Fiber.join(failing))._tag, "LaunchFailed")
      yield* launch
      const id = (yield* db.session.latestRoot(projectId))!.id

      const executions = yield* sql<{ outcome: string | null }>`SELECT outcome FROM execution
        WHERE session_id = ${id} ORDER BY id`

      assert.deepStrictEqual(
        executions.map((e) => e.outcome),
        ["not_started", null],
      )
    }),
  )

  test(
    "Launch passes VIBEST_PROJECT_ID and VIBEST_SESSION_ID to open and calls rt.present with session and projectId",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const repo = yield* makeRepository
      const projectId = yield* projectOf(repo)
      const c = asCli(yield* client, repo)

      const opened = yield* c.Launch({
        projectId,
        agent: "coordinator",
        harness: "pi",
        focus: false,
        runtime: "herdr",
        callerEnv: {},
      })

      const opens = yield* herdr.callsTo("open")
      const lastOpen = opens.at(-1)
      assert.isDefined(lastOpen)
      assert.strictEqual(lastOpen?.env.VIBEST_PROJECT_ID, projectId)
      assert.strictEqual(lastOpen?.env.VIBEST_SESSION_ID, opened.sessionId)

      const presents = yield* herdr.callsTo("present")
      const matched = presents.find((call) => call.info.session === opened.sessionId)
      assert.isDefined(matched)
      assert.strictEqual(matched?.info.projectId, projectId)
    }),
  )

  test(
    "Launch with an exited child sessionId opens in the child worktree with the child system prompt",
    Effect.gen(function* () {
      const db = yield* Db.Service
      const fs = yield* FileSystem.FileSystem
      const herdr = yield* FakeRuntime
      const repo = yield* makeRepository
      const projectId = yield* projectOf(repo)
      const raw = yield* client
      const spawner = yield* asEntry(raw, repo)
      const { id: childId } = yield* spawner.Spawn({ agent: "general", callerEnv: {}, harness: "pi", prompt: "do it" })
      yield* until(
        db.session.getSession(childId),
        (row) => (row?.process?.placedAt ?? null) !== null && row?.status === "working",
      )
      const childWorktree = yield* db.session.sessionDirectory(childId)
      assert.isDefined(childWorktree)
      assert.notStrictEqual(childWorktree, repo)

      yield* db.session.endProcess(childId, "exited")

      const c = asCli(raw, repo)
      yield* c.Launch({
        projectId,
        sessionId: childId,
        focus: false,
        runtime: "herdr",
        callerEnv: {},
      })

      const opens = yield* herdr.callsTo("open")
      const lastOpen = opens.at(-1)
      assert.strictEqual(lastOpen?.cwd, childWorktree)

      const runs = yield* herdr.callsTo("run")
      const lastRun = runs.at(-1)
      assert.isDefined(lastRun)
      const promptFlagIndex = lastRun!.argv.indexOf("--append-system-prompt")
      const promptPath = promptFlagIndex === -1 ? undefined : lastRun!.argv[promptFlagIndex + 1]
      assert.isDefined(promptPath)
      const promptText = yield* fs.readFileString(promptPath!)
      assert.notInclude(promptText, "do not edit files here")
    }),
  )

  test(
    "Launch refuses a running root session without move, and moves it when move: true is passed",
    Effect.gen(function* () {
      const repo = yield* makeRepository
      const projectId = yield* projectOf(repo)
      const c = asCli(yield* client, repo)

      const first = yield* c.Launch({
        projectId,
        agent: "coordinator",
        harness: "pi",
        focus: false,
        runtime: "herdr",
        callerEnv: {},
      })

      const refused = yield* Effect.flip(
        c.Launch({
          projectId,
          agent: "coordinator",
          harness: "pi",
          focus: false,
          runtime: "herdr",
          callerEnv: {},
        }),
      )

      assert.strictEqual(refused._tag, "Forbidden")

      const moved = yield* c.Launch({
        projectId,
        sessionId: first.sessionId,
        move: true,
        agent: "coordinator",
        harness: "pi",
        focus: false,
        runtime: "herdr",
        callerEnv: {},
      })

      assert.strictEqual(moved.sessionId, first.sessionId)
      assert.notStrictEqual(moved.terminal, first.terminal)
    }),
  )
})
