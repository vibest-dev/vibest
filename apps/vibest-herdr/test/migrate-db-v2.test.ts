import { Database } from "bun:sqlite"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { assert, describe, it } from "@effect/vitest"
import { APPLICATION_ID, Db, MIGRATE_V2_COMMAND } from "@vibest/core/db"
import { Cause, Effect, Exit, Layer } from "effect"
import { SqlClient } from "effect/sql"

import * as Platform from "#platform"

import { migrateDbV2, preportRuntime } from "../scripts/migrate-db-v2.ts"

/** The version 1 schema, as the last version 1 build installed it. */
const V1 = [
  `PRAGMA application_id = ${APPLICATION_ID}`,
  "PRAGMA user_version = 1",
  `CREATE TABLE project (id INTEGER PRIMARY KEY, directory TEXT NOT NULL UNIQUE,
    main_session_id TEXT REFERENCES session (id)) STRICT`,
  `CREATE TABLE session (id TEXT PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES project (id),
    parent_session_id TEXT REFERENCES session (id), agent_type TEXT NOT NULL, harness TEXT NOT NULL,
    directory TEXT NOT NULL, runtime TEXT, harness_session_id TEXT, metadata TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL, ended_at INTEGER) STRICT`,
  "CREATE INDEX session_project ON session (project_id)",
  "CREATE INDEX session_parent ON session (parent_session_id)",
  `CREATE TABLE inbox (id INTEGER PRIMARY KEY, recipient_session_id TEXT NOT NULL REFERENCES session (id),
    sender_type TEXT NOT NULL, sender_id TEXT, content TEXT NOT NULL,
    result_message_id INTEGER REFERENCES message (id), delivery_status TEXT NOT NULL) STRICT`,
  "CREATE INDEX inbox_pending ON inbox (recipient_session_id, delivery_status)",
  `CREATE TABLE message (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL REFERENCES session (id),
    inbox_id INTEGER REFERENCES inbox (id), input TEXT NOT NULL, output TEXT, status TEXT NOT NULL,
    metadata TEXT NOT NULL DEFAULT '{}', started_at INTEGER NOT NULL, ended_at INTEGER) STRICT`,
  "CREATE INDEX message_session ON message (session_id)",
]

const runtime = (id: string) => JSON.stringify({ kind: "herdr", machine: "local", id })

/** A version 1 file: a live main agent and the one `vibest --new` ended, a working subagent and an archived one. */
const writeV1 = (file: string) => {
  const db = new Database(file)
  db.exec("PRAGMA journal_mode = WAL")
  for (const statement of V1) db.run(statement)
  const session = db.prepare(`INSERT INTO session (id, project_id, parent_session_id, agent_type, harness, directory,
    runtime, harness_session_id, metadata, created_at, ended_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  db.run("INSERT INTO project (id, directory) VALUES (1, 'github.com/o/r')")
  session.run("m0000000", null, "main", "pi", "github.com/o/r", null, "old-conv", "{}", 1, 50)
  session.run(
    "m0000001",
    null,
    "main",
    "claude",
    "github.com/o/r",
    runtime("w/main"),
    "conv-main",
    JSON.stringify({ projectDirectory: "/repo", pid: 4242, integration: { version: "1.0.0", protocol: 2 } }),
    51,
    null,
  )
  db.run("UPDATE project SET main_session_id = 'm0000001'")
  session.run(
    "aaaaaaaa",
    "m0000001",
    "general",
    "pi",
    "/wt/a",
    runtime("w/a"),
    "conv-a",
    JSON.stringify({
      name: "fix it",
      provider: "anthropic",
      model: "m1",
      startedAt: 10,
      exitedAt: null,
      lastActive: 30,
      task: 1,
      archive: true,
      ready: 12,
      pid: 777,
      stop: [{ pane: "w/x", pids: [1], exited: true }],
      attempts: [{ harness: "claude", outcome: "limited", at: 5 }],
    }),
    9,
    null,
  )
  session.run(
    "bbbbbbbb",
    null,
    "general",
    "pi",
    "/wt/b",
    runtime("w/b"),
    null,
    JSON.stringify({ name: "gone", startedAt: 20, exitedAt: 40, archived: true, removed: true, task: 3 }),
    19,
    null,
  )
  const inbox = db.prepare(`INSERT INTO inbox (id, recipient_session_id, sender_type, sender_id, content,
    result_message_id, delivery_status) VALUES (?, ?, ?, ?, ?, ?, ?)`)
  inbox.run(1, "aaaaaaaa", "user", "m0000001", "do it", null, "delivered")
  inbox.run(2, "aaaaaaaa", "user", null, "and more", null, "delivered")
  inbox.run(3, "bbbbbbbb", "user", null, "other task", null, "delivered")
  inbox.run(5, "m0000001", "system", "aaaaaaaa", "a notice", null, "pending")
  inbox.run(6, "m0000001", "session", "bbbbbbbb", "a report", null, "dropped")
  inbox.run(7, "aaaaaaaa", "user", null, "still queued", null, "pending")
  const message = db.prepare(`INSERT INTO message (id, session_id, inbox_id, input, output, status, metadata,
    started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  message.run(1, "aaaaaaaa", 1, "do it", "done", "completed", '{"summary":"done"}', 10, 20)
  message.run(2, "aaaaaaaa", 2, "and more", null, "working", "{}", 25, null)
  message.run(3, "bbbbbbbb", 3, "other task", "broke", "failed", '{"error":"boom"}', 21, 39)
  inbox.run(
    4,
    "m0000001",
    "session",
    "aaaaaaaa",
    "<agent-result><summary>done</summary></agent-result>",
    1,
    "delivered",
  )
  return db
}

const database = (file: string) => Db.layer.pipe(Layer.provideMerge(Platform.sqlite(file)))

describe("migrate-db-v2", () => {
  it.effect("vibestd refuses a version 1 file and names the migration; the script moves it to version 2", () =>
    Effect.gen(function* () {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-migrate-"))
      const file = path.join(dir, "vibest.db")
      writeV1(file).close()

      const refused = yield* Effect.exit(Effect.void.pipe(Effect.provide(database(file))))
      assert.isTrue(Exit.isFailure(refused))
      assert.include(Exit.isFailure(refused) ? Cause.pretty(refused.cause) : "", MIGRATE_V2_COMMAND)

      const { backup } = migrateDbV2(file, 1234)
      assert.strictEqual(backup, `${file}.v1-backup-1234`)
      const kept = new Database(backup, { readonly: true })
      assert.strictEqual((kept.query("PRAGMA user_version").get() as { user_version: number }).user_version, 1)
      assert.strictEqual((kept.query("SELECT count(*) AS n FROM message").get() as { n: number }).n, 3)
      kept.close()
      // Version 2 is not migrated again.
      assert.throws(() => migrateDbV2(file, 5678), /not a version 1 vibest.db/)

      yield* Effect.gen(function* () {
        const db = yield* Db
        const sql = yield* SqlClient.SqlClient
        assert.strictEqual((yield* sql<{ userVersion: number }>`PRAGMA user_version`)[0]!.userVersion, 2)
        const project = yield* db.projectId("github.com/o/r")
        const main = (yield* db.coordinatorOf(project))!
        assert.deepInclude(main, {
          id: "m0000001",
          harnessId: "claude",
          harnessSessionId: "conv-main",
          runtime: "herdr",
          projectDirectory: "/repo",
          pid: 4242,
          integration: { version: "1.0.0", protocol: 2 },
        })
        assert.deepStrictEqual(main.address, { machine: "local", id: "w/main" })

        const a = (yield* db.getSession("aaaaaaaa"))!
        assert.deepInclude(a, {
          harnessId: "pi",
          harnessSessionId: "conv-a",
          name: "fix it",
          provider: "anthropic",
          model: "m1",
          startedAt: 10,
          exitedAt: null,
          turnState: "open",
          turnPromptedAt: 25,
        })
        assert.deepStrictEqual(a.address, { machine: "local", id: "w/a" })
        assert.isTrue(a.metadata.archive)
        assert.notProperty(a.metadata, "stop")
        assert.strictEqual(a.metadata.pid, 777)
        assert.strictEqual(a.metadata.ready, 12)
        assert.deepStrictEqual(
          a.metadata.attempts?.map((t) => [t.harness, t.at]),
          [["claude", 5]],
        )
        assert.deepStrictEqual(yield* db.rescheduleSource("aaaaaaaa"), {
          working: "and more",
          delivered: "",
          parentSessionId: "m0000001",
        })
        assert.deepStrictEqual(
          (yield* db.pendingInbox("aaaaaaaa")).map((r) => r.message),
          ["still queued"],
        )
        const result = (yield* db.latestInbox("aaaaaaaa", "result"))!
        assert.deepInclude(result, { status: "delivered" })
        assert.deepInclude(result.details, { status: "completed", summary: "done" })
        assert.strictEqual((yield* db.latestInbox("aaaaaaaa", "notice"))!.status, "pending")

        assert.deepStrictEqual(
          (yield* db.listSessions()).map((r) => r.id),
          ["aaaaaaaa"],
        )
        const b = (yield* db.listSessions({ stopped: true })).find((r) => r.id === "bbbbbbbb")!
        assert.deepInclude(b, { exitedAt: 40, turnState: "failed" })
        assert.isTrue(b.metadata.archived)
        assert.strictEqual((yield* db.latestInbox("bbbbbbbb", "report"))!.status, "dropped")

        const briefs = yield* db.sessionBriefs(["aaaaaaaa", "bbbbbbbb"])
        assert.deepStrictEqual(briefs.get("aaaaaaaa"), {
          task: "do it",
          latest: { status: "working", summary: "", endedAt: null },
        })
        assert.deepStrictEqual(briefs.get("bbbbbbbb"), {
          task: "other task",
          latest: { status: "failed", summary: "broke", endedAt: 39 },
        })
        // The replaced main conversation is an ended main session.
        assert.isNotNull((yield* db.getSession("m0000000"))?.exitedAt)
        assert.deepStrictEqual(
          yield* sql`SELECT id, report_to_session_id FROM session WHERE role != 'main' ORDER BY id`,
          [
            { id: "aaaaaaaa", reportToSessionId: "m0000001" },
            { id: "bbbbbbbb", reportToSessionId: "m0000001" },
          ],
        )
        assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, [])
      }).pipe(Effect.provide(database(file)))
      fs.rmSync(dir, { recursive: true, force: true })
    }),
  )

  it("a runtime from before the runtime port keeps the agent name those builds gave the row: `s-<id>` rides in the id", () => {
    assert.strictEqual(
      preportRuntime('{"type":"herdr","session":"work","pane":"w1:p2"}', "ab12"),
      '{"kind":"herdr","machine":"local","id":"work/w1:p2/s-ab12"}',
    )
    // A row without a pane is core's "no terminal"; anything else is left alone.
    assert.strictEqual(
      preportRuntime('{"type":"herdr","session":"work"}', "ab12"),
      '{"kind":"herdr","machine":"local","id":""}',
    )
    assert.isUndefined(preportRuntime('{"kind":"herdr","machine":"local","id":"work/w1:p2/s-ab12"}', "ab12"))
    assert.isUndefined(preportRuntime("not json", "ab12"))
  })

  it("a file that is not version 1 is left as it is", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-migrate-"))
    const file = path.join(dir, "other.db")
    const db = new Database(file)
    db.run("CREATE TABLE other (id INTEGER PRIMARY KEY)")
    db.close()
    const before = fs.readFileSync(file)
    assert.throws(() => migrateDbV2(file), /not a version 1 vibest.db/)
    assert.deepStrictEqual(fs.readFileSync(file), before)
    assert.deepStrictEqual(fs.readdirSync(dir), ["other.db"])
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
