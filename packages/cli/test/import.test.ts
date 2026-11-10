import { Database } from "bun:sqlite"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { SqliteClient } from "@effect/sql-sqlite-bun"
import { assert, describe, it } from "@effect/vitest"
import { SQL_NAMES } from "@vibest/core/db"
import { importCheck, ImportFailed, importInPlace, v2Reader } from "@vibest/core/import/import"
import { compare, viewOf } from "@vibest/core/import/referee"
import { highestId, translate } from "@vibest/core/import/translate"
import { probesOf, readSnapshot, v1Reader } from "@vibest/core/import/v1-read"
import { append, equalToReplay, installLedger, LEDGER_VERSION } from "@vibest/core/journal"
import type { Fact } from "@vibest/schema/event"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"

const FIXTURES = path.join(import.meta.dirname, "fixtures", "v1")
const PASSING = ["sessions", "machines", "handwritten"] as const

const client = (filename: string, readonly = false) =>
  Layer.build(Layer.fresh(SqliteClient.layer({ filename, readonly, disableWAL: true, ...SQL_NAMES }))).pipe(
    Effect.flatMap((context) => SqlClient.SqlClient.pipe(Effect.provide(context))),
  )

const fixtureFile = (name: string) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-import-"))
  const file = path.join(directory, "vibest.db")
  const db = new Database(file)
  db.exec(fs.readFileSync(path.join(FIXTURES, `${name}.sql`), "utf8"))
  db.close()
  return file
}

const shape = (file: string) => {
  const db = new Database(file, { readonly: true })
  const [{ user_version }] = db.query("PRAGMA user_version").all() as [{ user_version: number }]
  const tables = (
    db.query("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>
  ).map(({ name }) => [name, (db.query(`SELECT count(*) AS n FROM "${name}"`).get() as { n: number }).n] as const)
  db.close()
  return { userVersion: user_version, tables }
}

const memory = Layer.fresh(SqliteClient.layer({ filename: ":memory:", disableWAL: true, ...SQL_NAMES }))

const imported = (name: string) =>
  Effect.gen(function* () {
    const file = fixtureFile(name)
    const sql = yield* client(file)
    const report = yield* importInPlace.pipe(Effect.provideService(SqlClient.SqlClient, sql))
    return { file, sql, report }
  })

const differencesAfter = (name: string, edit: (facts: ReadonlyArray<Fact>) => ReadonlyArray<Fact>) =>
  Effect.gen(function* () {
    const source = yield* client(fixtureFile(name), true)
    const snapshot = yield* readSnapshot(source)
    const translation = translate(snapshot, 0)
    const seqOf = {
      event: (id: number) => translation.eventSeq.get(id) ?? -id,
      inbox: (id: number) => translation.inboxSeq.get(id) ?? -id,
    }
    const v1 = yield* viewOf(v1Reader(source, snapshot, seqOf), probesOf(snapshot))
    const scratch = yield* client(":memory:")
    yield* Effect.gen(function* () {
      yield* installLedger
      for (const fact of edit(translation.facts)) yield* append(fact)
    }).pipe(Effect.provideService(SqlClient.SqlClient, scratch))
    return compare(v1, yield* viewOf(v2Reader(scratch), probesOf(snapshot)))
  })

type Data = Record<string, unknown>

const first = (facts: ReadonlyArray<Fact>, type: Fact["type"], where: (data: Data) => boolean = () => true) => {
  const index = facts.findIndex((fact) => fact.type === type && where(fact.data as Data))
  if (index === -1) throw new Error(`no ${type} fact to break`)
  return index
}

const changed =
  (type: Fact["type"], change: (data: Data) => Data, where?: (data: Data) => boolean) =>
  (facts: ReadonlyArray<Fact>) => {
    const index = first(facts, type, where)
    return facts.map((fact, i) => (i === index ? ({ ...fact, data: change(fact.data as Data) } as Fact) : fact))
  }

const dropped = (type: Fact["type"], where?: (data: Data) => boolean) => (facts: ReadonlyArray<Fact>) => {
  const index = first(facts, type, where)
  return facts.filter((_, i) => i !== index)
}

const swappedTurnStatuses = (facts: ReadonlyArray<Fact>) => {
  const completed = first(facts, "turn.ended", (data) => data["status"] === "completed")
  const failed = first(facts, "turn.ended", (data) => data["status"] === "failed")
  const status = (i: number) => (facts[i]!.data as Data)["status"]
  return facts.map((fact, i) =>
    i === completed || i === failed
      ? ({ ...fact, data: { ...(fact.data as Data), status: status(i === completed ? failed : completed) } } as Fact)
      : fact,
  )
}

const BREAKAGES: ReadonlyArray<
  readonly [string, (typeof PASSING)[number], (facts: ReadonlyArray<Fact>) => ReadonlyArray<Fact>]
> = [
  ["a process harness", "sessions", changed("process.started", (d) => ({ ...d, harness: "cursor" }))],
  ["a dropped inbox.moved", "sessions", dropped("inbox.moved")],
  ["two swapped turn statuses", "sessions", swappedTurnStatuses],
  ["a dropped outbox row", "machines", dropped("outbox.queued")],
  [
    "a peer item",
    "machines",
    changed(
      "inbox.queued",
      (d) => ({ ...d, peerItem: "other" }),
      (d) => "peerItem" in d,
    ),
  ],
  [
    "an unconsumed reported text",
    "sessions",
    changed(
      "turn.reported",
      (d) => ({ ...d, text: "something else" }),
      (d) => d["text"] === "Docs updated.",
    ),
  ],
  ["a session name", "sessions", changed("session.created", (d) => ({ ...d, name: "renamed" }))],
  [
    "a repository remote",
    "sessions",
    changed("project.created", (d) => ({ ...d, repositories: [{ path: "/w/app", remote: "git@other:app.git" }] })),
  ],
  [
    "a terminal",
    "sessions",
    changed(
      "process.started",
      (d) => ({ ...d, terminal: "w9:p9" }),
      (d) => "terminal" in d,
    ),
  ],
  [
    "a ready pid",
    "sessions",
    changed(
      "process.ready",
      (d) => ({ ...d, pid: 1 }),
      (d) => "pid" in d,
    ),
  ],
  ["an inbox content", "sessions", changed("inbox.queued", (d) => ({ ...d, content: "changed" }))],
  ["a machine target", "machines", changed("machine.added", (d) => ({ ...d, target: "root@elsewhere" }))],
  ["a peer name", "machines", changed("peer.seen", (d) => ({ ...d, name: "renamed" }))],
  ["a dropped archive", "sessions", dropped("session.ended")],
  [
    "a process end reason",
    "sessions",
    changed(
      "process.ended",
      (d) => ({ ...d, reason: "exited" }),
      (d) => d["reason"] === "limited",
    ),
  ],
  [
    "a typed prompt",
    "sessions",
    changed(
      "turn.started",
      (d) => ({ ...d, typed: "other words" }),
      (d) => "typed" in d,
    ),
  ],
  [
    "a task row status",
    "sessions",
    (facts) => {
      const task = first(facts, "inbox.queued", (d) => d["kind"] === "task")
      return facts.filter(
        (fact, i) => i === task || fact.type !== "inbox.moved" || (fact.data as Data)["inbox"] !== facts[task]!.seq,
      )
    },
  ],
  [
    "a task sender",
    "sessions",
    changed(
      "inbox.queued",
      (d) => ({ ...d, sender: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
      (d) => d["kind"] === "task" && "sender" in d,
    ),
  ],
  ["a conversation id", "sessions", changed("process.conversation", (d) => ({ ...d, conversation: "other" }))],
]

describe("v1 import", () => {
  for (const name of PASSING)
    it.effect(`${name} imports, the referee passes and the projections equal a replay`, () =>
      Effect.gen(function* () {
        const { file, sql, report } = yield* imported(name)
        assert.deepStrictEqual(report.differences, [])
        assert.isUndefined(yield* equalToReplay(sql).pipe(Effect.provide(memory)))
        assert.strictEqual(shape(file).userVersion, LEDGER_VERSION)
      }),
    )

  it.effect("the handwritten fixture counts its repeated peer key", () =>
    Effect.gen(function* () {
      const { report } = yield* imported("handwritten")
      assert.deepStrictEqual(report.counts, {
        endsOfEndedProcesses: 0,
        turnsLost: 0,
        endsOfEndedTurns: 0,
        duplicatePeerKeys: 1,
        undecodablePeerStarts: 0,
      })
    }),
  )

  it.effect("imported seqs start above every v1 event and inbox id", () =>
    Effect.gen(function* () {
      const file = fixtureFile("sessions")
      const v1 = new Database(file, { readonly: true })
      const { highest } = v1
        .query("SELECT max((SELECT max(id) FROM event), (SELECT max(id) FROM inbox)) AS highest")
        .get() as { highest: number }
      v1.close()
      const sql = yield* client(file)
      yield* importInPlace.pipe(Effect.provideService(SqlClient.SqlClient, sql))
      const [row] = yield* sql<{ lowest: number }>`SELECT min(seq) AS lowest FROM event`
      assert.isAbove(row!.lowest, highest)
    }),
  )

  it.effect("a failing referee leaves the v1 database as it was", () =>
    Effect.gen(function* () {
      const file = fixtureFile("referee-fails")
      const before = shape(file)
      const sql = yield* client(file)
      const error = yield* Effect.flip(importInPlace.pipe(Effect.provideService(SqlClient.SqlClient, sql)))
      assert.instanceOf(error, ImportFailed)
      assert.deepStrictEqual(shape(file), before)
      assert.strictEqual(before.userVersion, 1)
    }),
  )

  it.effect("import-check reads a read-only source and reports the referee result without writing", () =>
    Effect.gen(function* () {
      const file = fixtureFile("referee-fails")
      const before = shape(file)
      const source = yield* client(file, true)
      const report = yield* importCheck(source).pipe(Effect.provide(memory))
      assert.isAbove(report.differences.length, 0)
      assert.deepStrictEqual(shape(file), before)
    }),
  )

  const edited = (name: string, statements: ReadonlyArray<string>) => {
    const file = fixtureFile(name)
    const db = new Database(file)
    const triggers = db.query("SELECT name, sql FROM sqlite_schema WHERE type = 'trigger'").all() as Array<{
      name: string
      sql: string
    }>
    for (const { name: trigger } of triggers) db.exec(`DROP TRIGGER "${trigger}"`)
    for (const statement of statements) db.exec(statement)
    for (const { sql } of triggers) db.exec(sql)
    db.close()
    return file
  }

  it.effect("an inbox row whose queued event has a higher id than its status event imports", () =>
    Effect.gen(function* () {
      const file = edited("sessions", [
        `UPDATE event SET id = (SELECT max(id) + 1 FROM event) WHERE id = (SELECT q.id FROM event q
          JOIN event s ON s.inbox_id = q.inbox_id AND s.type = 'inbox.status'
          WHERE q.type = 'inbox.queued' ORDER BY q.id LIMIT 1)`,
      ])
      const v1 = new Database(file, { readonly: true })
      const late = v1
        .query(`SELECT count(*) AS n FROM event q JOIN event s ON s.inbox_id = q.inbox_id AND s.type = 'inbox.status'
          WHERE q.type = 'inbox.queued' AND q.id > s.id`)
        .get() as { n: number }
      v1.close()
      assert.strictEqual(late.n, 1)
      const sql = yield* client(file)
      const report = yield* importInPlace.pipe(Effect.provideService(SqlClient.SqlClient, sql))
      assert.deepStrictEqual(report.differences, [])
      assert.isUndefined(yield* equalToReplay(sql).pipe(Effect.provide(memory)))
    }),
  )

  it.effect("import-check reports every translation problem at once", () =>
    Effect.gen(function* () {
      const file = edited("sessions", [
        `INSERT INTO event (at, session_id, type, data) SELECT 1, id, 'bogus.one', '{}' FROM session LIMIT 1`,
        `INSERT INTO event (at, session_id, type, data) SELECT 2, id, 'bogus.two', '{}' FROM session LIMIT 1`,
      ])
      const source = yield* client(file, true)
      const error = yield* Effect.flip(importCheck(source).pipe(Effect.provide(memory)))
      assert.instanceOf(error, ImportFailed)
      assert.match(error.message, /2 problems/)
      assert.match(error.message, /bogus\.one/)
      assert.match(error.message, /bogus\.two/)
    }),
  )

  it("the highest v1 id is found among more ids than a call can take as arguments", () => {
    const events = Array.from({ length: 1_000_000 }, (_, i) => ({ id: i + 1 }))
    const inbox = Array.from({ length: 1_000_000 }, (_, i) => ({ id: i + 7 }))
    assert.strictEqual(highestId({ events, inbox } as never), 1_000_006)
  })

  it.effect("imports inside an outer transaction with foreign keys on", () =>
    Effect.gen(function* () {
      const sql = yield* client(fixtureFile("sessions"))
      yield* sql.unsafe("PRAGMA foreign_keys = ON")
      const report = yield* sql.withTransaction(importInPlace.pipe(Effect.provideService(SqlClient.SqlClient, sql)))
      assert.deepStrictEqual(report.differences, [])
    }),
  )

  const snapshotOf = (name: string) => Effect.flatMap(client(fixtureFile(name), true), readSnapshot)

  it.effect("a second end of an ended turn is counted, not imported", () =>
    Effect.gen(function* () {
      const snapshot = yield* snapshotOf("sessions")
      const end = snapshot.events.find((e) => e.type === "turn.end")!
      const again = { ...end, id: highestId(snapshot) + 1, at: end.at + 1 }
      const translation = translate({ ...snapshot, events: [...snapshot.events, again] }, 0)
      assert.strictEqual(translation.counts.endsOfEndedTurns, 1)
      assert.strictEqual(translation.facts.length, translate(snapshot, 0).facts.length)
    }),
  )

  it.effect("a turn end whose report is not an event id fails the import", () =>
    Effect.gen(function* () {
      const snapshot = yield* snapshotOf("sessions")
      const events = snapshot.events.map((e) =>
        e.type === "turn.end" ? { ...e, data: JSON.stringify({ ...JSON.parse(e.data), report: "r1" }) } : e,
      )
      assert.throws(() => translate({ ...snapshot, events }, 0), /is not an event id/)
    }),
  )

  for (const [what, fixture, edit] of BREAKAGES)
    it.effect(`the referee notices ${what}`, () =>
      Effect.gen(function* () {
        assert.isAbove((yield* differencesAfter(fixture, edit)).length, 0)
      }),
    )
})
