import { assert, describe } from "@effect/vitest"
import { Db } from "@vibest/core/database/db"
import { projectRoot } from "@vibest/core/project/create"
import { FakeRuntime, makeRepository, until, projectOf } from "@vibest/platform-bun/test/lib/fakes"
import { test, client, asCli, asEntry } from "@vibest/platform-bun/test/lib/rpc-helpers"
import { Plugin } from "@vibest/plugin/effect"
import { Effect, Fiber, Path, Predicate, Ref } from "effect"
import { SqlClient } from "effect/sql"

describe("vibest.sock", () => {
  const seenDirectory = { project: "" }
  test(
    "Project.StartEntry schedules with the project directory, not its key; with no harness it fails until an entry session exists, then takes its harness",
    Effect.gen(function* () {
      const repo = yield* makeRepository
      const c = asCli(yield* client, repo)
      const first = yield* Effect.flip(c["Project.StartEntry"]({ agent: "general", runtime: "herdr" }))
      assert.strictEqual(first._tag, "LaunchFailed")
      assert.match(first.message, /no harness to inherit/)
      assert.strictEqual(
        (yield* c["Project.StartEntry"]({ agent: "general", runtime: "herdr", harness: "pi" })).harness,
        "pi",
      )
      assert.strictEqual(seenDirectory.project, (yield* projectRoot(repo)).root)
      assert.notStrictEqual(seenDirectory.project, yield* projectOf(repo))
      yield* c["Project.EntrySession"]({
        agent: "coordinator",
        harness: "claude",
        fresh: false,
        terminal: { id: "test/p1" },
      })
      assert.strictEqual((yield* c["Project.StartEntry"]({ agent: "general", runtime: "herdr" })).harness, "claude")
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
    "List shows the entry session's live status from its pane, not a stored unknown",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const repo = yield* makeRepository
      const c = asCli(yield* client, repo)
      const pane = "w1:coord"
      yield* herdr.seedAgent(pane)
      yield* c["Project.EntrySession"]({ agent: "coordinator", harness: "pi", fresh: false, terminal: { id: pane } })
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
    "archive refuses an entry session and names its project",
    Effect.gen(function* () {
      const db = yield* Db.Service
      const path = yield* Path.Path
      const repo = yield* makeRepository
      const projectId = yield* projectOf(repo)
      yield* db.session.startEntry(
        projectId,
        "pi",
        false,
        {
          runtime: "herdr",
          target: { id: "test/main" },
        },
        { agent: "coordinator" },
      )
      const entry = (yield* db.session.entryOf(projectId))!
      const failed = yield* Effect.flip(asCli(yield* client, repo).Archive({ id: entry.id }))
      assert.strictEqual(failed._tag, "NoSuchSession")
      assert.strictEqual(
        "message" in failed ? failed.message : "",
        `${entry.id} is the session you opened in a terminal (project ${path.basename(repo)}); stop it in that terminal.`,
      )
    }),
  )

  test(
    "FocusEntry reports a runtime that cannot focus",
    Effect.gen(function* () {
      const db = yield* Db.Service
      const herdr = yield* FakeRuntime
      const repo = yield* makeRepository
      const projectId = yield* projectOf(repo)
      yield* db.session.startEntry(
        projectId,
        "pi",
        false,
        {
          runtime: "herdr",
          target: { id: "test/main" },
        },
        { agent: "coordinator" },
      )
      yield* herdr.seedAgent("test/main")
      const focused = yield* asCli(yield* client, repo)["Project.FocusEntry"]({})
      assert.strictEqual(focused?.focused, false)
      assert.strictEqual((yield* herdr.callsTo("focus")).length, 0)
    }),
    { noFocus: true },
  )

  test(
    "--new with a missing harness does not archive the current entry session",
    Effect.gen(function* () {
      const db = yield* Db.Service
      const repo = yield* makeRepository
      const projectId = yield* projectOf(repo)
      yield* db.session.startEntry(
        projectId,
        "pi",
        false,
        {
          runtime: "herdr",
          target: { id: "test/main" },
        },
        { agent: "coordinator" },
      )
      const before = (yield* db.session.entryOf(projectId))!.id

      const failed = yield* Effect.flip(
        asCli(yield* client, repo).Launch({
          agent: "coordinator",
          callerEnv: {},
          argv: ["/bin/vibest", "--harness", "cursor", "--new"],
          focus: false,
          runtime: "herdr",
        }),
      )

      assert.ok(Predicate.isTagged(failed, "LaunchFailed") || Predicate.isTagged(failed, "AgentRefused"), failed._tag)
      assert.strictEqual((yield* db.session.entryOf(projectId))!.id, before)
    }),
    { missingBinary: ["cursor"] },
  )

  test(
    "an entry launch whose typing fails leaves no open execution: the next start runs its first input",
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
          argv: ["/bin/vibest", "--harness", "cursor"],
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
      const id = (yield* db.session.entryOf(projectId))!.id

      const executions = yield* sql<{ outcome: string | null }>`SELECT outcome FROM execution
        WHERE session_id = ${id} ORDER BY id`

      assert.deepStrictEqual(
        executions.map((e) => e.outcome),
        ["not_started", null],
      )
    }),
  )
})
