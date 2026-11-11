import { dlopen, FFIType } from "bun:ffi"
import { Database } from "bun:sqlite"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { SqliteClient } from "@effect/sql-sqlite-bun"
import { assert, describe, it } from "@effect/vitest"
import { SQL_NAMES } from "@vibest/core/db"
import { inspectSchema } from "@vibest/core/db-schema"
import { makeJournal } from "@vibest/core/journal"
import { SessionRenamed } from "@vibest/schema/event"
import { Effect } from "effect"

import rewritten from "../../../packages/schema/test/event-rows.json" with { type: "json" }
import { run } from "../src/main.ts"
import { canonical, planRewrite, referee } from "../src/rewrite.ts"
import old from "./event-rows.json" with { type: "json" }

const P = "11111111-1111-4111-8111-111111111111"
const M = "22222222-2222-4222-8222-222222222222"
const S = "33333333-3333-4333-8333-333333333333"
const T = "44444444-4444-4444-8444-444444444444"
const PEER = "55555555-5555-4555-8555-555555555555"
const OUT = "66666666-6666-4666-8666-666666666666"
const VIBESTD = "77777777-7777-4777-8777-777777777777"

type Old = readonly [type: string, project: string | null, session: string | null, data: object]

const realistic: ReadonlyArray<Old> = [
  ["project.created", P, null, { repositories: [] }],
  ["session.created", P, M, { role: "main", name: "main", directory: "", archiveOnCompletion: false }],
  ["project.entry_changed", P, null, { session: M }],
  [
    "session.created",
    P,
    S,
    { role: "subagent", name: "w", directory: "/d", parent: M, reportTo: M, archiveOnCompletion: true },
  ],
  ["process.started", P, S, { harness: "claude", runtime: "herdr", terminal: "t1" }],
  ["inbox.queued", P, S, { kind: "task", recipient: S, sender: M, content: "do", status: "delivered", request: "r1" }],
  ["turn.started", P, S, { process: 5 }],
  ["inbox.moved", P, S, { inbox: 6, to: "delivered", turn: 7 }],
  ["turn.reported", P, S, { process: 5, harness: "claude", text: "done", conversation: "c1" }],
  ["turn.ended", P, S, { turn: 7, status: "completed", report: 9 }],
  ["inbox.queued", P, M, { kind: "report", recipient: M, sender: S, content: "S done", status: "pending", turn: 7 }],
  ["turn.started", P, S, { process: 5 }],
  ["turn.reported", P, S, { harness: "claude", text: "late a" }],
  ["turn.reported", P, S, { harness: "claude", text: "late b", error: "boom" }],
  ["process.started", P, M, { harness: "pi", runtime: "herdr", terminal: "t2" }],
  ["peer.seen", null, null, { id: PEER, name: "far", callsMe: "near" }],
  ["outbox.queued", P, S, { id: OUT, peer: PEER, kind: "result", content: "w done" }],
  ["machine.added", null, null, { name: "far", target: "ssh far", vibestd: VIBESTD }],
  ["session.created", P, T, { role: "subagent", name: "t", directory: "/d", parent: M, archiveOnCompletion: false }],
  ["process.started", P, T, { harness: "claude", runtime: "herdr", terminal: "t3" }],
  ["turn.started", P, T, { process: 20 }],
  ["turn.ended", P, T, { turn: 21, status: "completed", reply: "r", conversation: "c2" }],
  ["turn.reported", P, M, { harness: "pi", text: "a late reply nobody reads" }],
]

const OLD_LOG = [
  `PRAGMA application_id = ${0x76696265}`,
  `CREATE TABLE event (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, type TEXT NOT NULL,
    project_id TEXT, session_id TEXT, data TEXT NOT NULL) STRICT`,
  `CREATE TRIGGER event_no_update BEFORE UPDATE ON event BEGIN SELECT RAISE(ABORT, 'event is append-only'); END`,
  `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT`,
  `CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL) STRICT`,
  `INSERT INTO meta VALUES ('catalog', '1'), ('projection', '4')`,
]

const oldDatabase = (events: ReadonlyArray<Old>) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-rewrite-"))
  const file = path.join(dir, "vibest.db")
  const db = new Database(file)
  for (const statement of OLD_LOG) db.run(statement)
  const insert = db.prepare("INSERT INTO event (at, type, project_id, session_id, data) VALUES (?, ?, ?, ?, ?)")
  events.forEach(([type, project, session, data], i) =>
    insert.run(1_800_000_000_000 + i * 1000, type, project, session, JSON.stringify(data)),
  )
  db.close()
  return file
}

const query = <T>(file: string, sql: string, ...args: ReadonlyArray<string | number>) => {
  const db = new Database(file, { readonly: true })
  try {
    return db.query(sql).all(...args) as Array<T>
  } finally {
    db.close()
  }
}

const digest = (file: string) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")

const onFile = (file: string) => Effect.provide(SqliteClient.layer({ filename: file, disableWAL: true, ...SQL_NAMES }))

describe("ledger rewrite", () => {
  it.effect("rewrites a realistic old log, keeps its read model, and drops only unread replies", () =>
    Effect.gen(function* () {
      const file = oldDatabase(realistic)
      const report = yield* run(file)
      assert.strictEqual(report.events, 23)
      assert.strictEqual(report.dropped, 2)
      assert.strictEqual(report.expected.length, 2)
      const meta = Object.fromEntries(
        query<{ key: string; value: string }>(file, "SELECT * FROM meta").map((r) => [r.key, r.value]),
      )
      assert.strictEqual(meta["catalog"], "2")
      assert.strictEqual(meta["projection"], "5")
      assert.match(meta["ledger"]!, /^[0-9a-f-]{36}$/)
      assert.deepStrictEqual(
        query(file, "SELECT session_id, id, outcome, reply, failure FROM execution ORDER BY session_id, id"),
        [
          { session_id: S, id: 7, outcome: "completed", reply: "done", failure: null },
          { session_id: S, id: 12, outcome: "failed", reply: "late b", failure: "boom" },
          { session_id: T, id: 21, outcome: "completed", reply: "r", failure: null },
        ],
      )
      assert.deepStrictEqual(query(file, "SELECT conversation FROM process WHERE session_id = ?", T), [
        { conversation: "c2" },
      ])
      assert.deepStrictEqual(
        query(file, "SELECT session_id, id, kind, execution_id FROM inbox ORDER BY session_id, id"),
        [
          { session_id: M, id: 11, kind: "notice", execution_id: null },
          { session_id: S, id: 6, kind: "task", execution_id: 7 },
        ],
      )
      assert.deepStrictEqual(query(file, "SELECT session_id, kind, seq FROM outbox"), [
        { session_id: S, kind: "notice", seq: 17 },
      ])
      assert.deepStrictEqual(query(file, "SELECT id, agent FROM session ORDER BY created_at"), [
        { id: M, agent: "main" },
        { id: S, agent: "subagent" },
        { id: T, agent: "subagent" },
      ])
      assert.deepStrictEqual(
        query(file, "SELECT aggregate, type FROM event WHERE seq IN (13, 14, 17, 23) ORDER BY position"),
        [
          { aggregate: S, type: "execution.ended" },
          { aggregate: meta["ledger"], type: "outbox.queued" },
        ],
      )
      assert.strictEqual(yield* inspectSchema.pipe(onFile(file)), "ready")
    }),
  )

  it.effect("new facts number on from their aggregate and never reuse a position", () =>
    Effect.gen(function* () {
      const file = oldDatabase(realistic)
      yield* run(file)
      const [seq, fresh] = yield* Effect.gen(function* () {
        const journal = yield* makeJournal(() => Effect.void)
        return [
          yield* journal.commit(journal.emit(SessionRenamed, { sessionId: M, data: { name: "renamed" } })),
          yield* journal.commit(journal.emit(SessionRenamed, { sessionId: T, data: { name: "t2" } })),
        ]
      }).pipe(onFile(file))
      assert.strictEqual(seq, 16)
      assert.strictEqual(fresh, 23)
      assert.deepStrictEqual(query(file, "SELECT position FROM event ORDER BY position DESC LIMIT 2"), [
        { position: 25 },
        { position: 24 },
      ])
    }),
  )

  it.effect("an old row its own catalog refuses leaves the database untouched", () =>
    Effect.gen(function* () {
      const file = oldDatabase([...realistic, ["session.renamed", P, S, { name: "x", extra: 1 }]])
      const before = digest(file)
      const error = yield* run(file).pipe(Effect.flip)
      assert.strictEqual(error._tag, "RewriteFailed")
      assert.include(error.message, "event 24: session.renamed does not decode")
      assert.strictEqual(digest(file), before)
    }),
  )

  it.effect("every rewritten row the new catalog refuses is named at once", () =>
    Effect.gen(function* () {
      const ledger = crypto.randomUUID()
      const rows = [
        { seq: 1, at: 1, type: "session.renamed", project_id: P, session_id: S, data: "{}" },
        { seq: 2, at: 2, type: "outbox.queued", project_id: P, session_id: S, data: "{}" },
      ]
      const plan = {
        rows: [
          { aggregate: S, seq: 1, at: 1, type: "session.renamed", data: '{"name":"x","extra":1}' },
          { aggregate: ledger, seq: 2, at: 2, type: "outbox.queued", data: '{"id":"x"}' },
        ],
        dropped: [],
        closed: [],
      }
      const error = yield* canonical(plan, rows, ledger).pipe(Effect.flip)
      assert.include(error.message, "2 rewritten events do not decode")
      assert.include(error.message, "event 1 (session.renamed → session.renamed)")
      assert.include(error.message, "event 2 (outbox.queued → outbox.queued)")
    }),
  )

  it.effect("refuses while vibestd holds its start lock", () =>
    Effect.gen(function* () {
      const file = oldDatabase(realistic)
      const libc = dlopen(process.platform === "darwin" ? "libc.dylib" : "libc.so.6", {
        flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      })
      const fd = fs.openSync(path.join(path.dirname(file), "vibestd.pid"), "w")
      assert.strictEqual(libc.symbols.flock(fd, 2 | 4), 0)
      const before = digest(file)
      const error = yield* run(file).pipe(Effect.flip, Effect.ensuring(Effect.sync(() => fs.closeSync(fd))))
      assert.include(error.message, "vibestd is running")
      assert.strictEqual(digest(file), before)
    }),
  )

  it.effect("refuses a database already in the new shape", () =>
    Effect.gen(function* () {
      const file = oldDatabase(realistic)
      yield* run(file)
      const error = yield* run(file).pipe(Effect.flip)
      assert.include(error.message, "already in the new event shape")
    }),
  )

  it.effect("the fixed sample of every old type and key rewrites to the catalog sample", () =>
    Effect.gen(function* () {
      const ledger = rewritten.find((row) => row.type === "outbox.acked")!.aggregate
      const rows = yield* canonical(planRewrite(old, ledger), old, ledger)
      assert.deepStrictEqual(rows, rewritten)
    }),
  )

  it("the referee names every row that differs at once", () => {
    const { differences } = referee(
      {
        project: [{ id: P, directory: "/a", entry_session_id: null }],
        project_repository: [],
        session: [],
        process: [],
        turn: [],
        inbox: [],
        machine: [{ name: "far", target: "x", vibestd_id: VIBESTD, connected_at: 1, created_at: 1 }],
        peer: [],
        outbox: [],
      },
      {
        project: [{ id: P, directory: "/b", entry_session_id: null }],
        project_repository: [],
        session: [],
        process: [],
        execution: [],
        inbox: [],
        machine: [],
        peer: [],
        outbox: [],
      },
      { rows: [], dropped: [], closed: [] },
    )
    assert.strictEqual(differences.length, 2)
    assert.include(differences[0]!, '"directory":"/b"')
    assert.include(differences[1]!, "machine far")
  })
})
