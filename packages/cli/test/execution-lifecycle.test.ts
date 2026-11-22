import { assert, describe, it } from "@effect/vitest"
import { Bus } from "@vibest/core/bus"
import { Db } from "@vibest/core/database/db"
import { checkLedger, open } from "@vibest/core/database/migration"
import * as Projectors from "@vibest/core/database/projectors"
import { SessionLive } from "@vibest/core/session/live"
import { projectOf, tempDirectory } from "@vibest/platform-bun/test/lib/fakes"
import { database, session } from "@vibest/platform-bun/test/lib/unit-helpers"
import { Catalog, CATALOG_VERSION } from "@vibest/schema/event"
import { Effect, Exit, FileSystem, Layer, Path } from "effect"
import { SqlClient } from "effect/sql"

import * as Platform from "#platform"

const S = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const MIGRATION = "20261122000000_execution_lifecycle"

const memoryDb = () =>
  Db.layer.pipe(
    Layer.provide(Projectors.layer),
    Layer.provideMerge(Bus.layer),
    Layer.provide(SessionLive.layer),
    Layer.provideMerge(Platform.sqlite(":memory:")),
  )

const withSession = Effect.gen(function* () {
  const db = yield* Db.Service
  yield* db.session.insertSession(session(S), yield* projectOf("life"))

  return db
})

const harnessEnd = (status: "completed" | "failed" | "interrupted", at: number, reply = "") => ({
  harness: "pi" as const,
  at,
  status,
  reply,
  failure: status === "failed" ? "boom" : undefined,
  limited: false,
  conversation: undefined,
  needsReady: false,
})

const P = "11111111-1111-4111-8111-111111111111"
const E = "22222222-2222-4222-8222-222222222222"
const PEER = "55555555-5555-4555-8555-555555555555"

type Fact = readonly [aggregate: string, seq: number, type: string, data: object]

const oldFacts = (ledger: string): ReadonlyArray<Fact> => [
  [P, 1, "project.created", { directory: "/p", repositories: [] }],
  [S, 1, "session.created", { project: P, agent: "general", name: "s", directory: "/p/s" }],
  [S, 2, "process.started", { harness: "pi", runtime: "herdr" }],
  [S, 3, "execution.started", { process: 2, typed: "typed line" }],
  [S, 4, "execution.accepted", { execution: 3 }],
  [S, 5, "execution.ended", { execution: 3, outcome: "completed", reply: "done", conversation: "conv-1" }],
  [S, 6, "execution.started", {}],
  [S, 7, "execution.ended", { execution: 6, outcome: "lost", failure: { message: "gone" } }],
  [S, 8, "execution.started", {}],
  [S, 9, "execution.ended", { execution: 8, outcome: "not_started" }],
  [E, 1, "session.created", { project: P, agent: "coordinator", name: "entry", directory: "/p" }],
  [
    E,
    2,
    "inbox.queued",
    {
      kind: "send",
      sender: { type: "agent", session: S },
      content: "hi",
      status: "pending",
      execution: 3,
    },
  ],
  [
    ledger,
    1,
    "outbox.queued",
    {
      id: "66666666-6666-4666-8666-666666666661",
      peer: PEER,
      session: S,
      kind: "send",
      content: "remote",
      execution: 3,
    },
  ],
]

const runner = (file: string) => Projectors.replay.pipe(Layer.provideMerge(Platform.sqlite(file)))

const oldLedger = Effect.gen(function* () {
  const path = yield* Path.Path
  const file = path.join(yield* tempDirectory("vibest-execution-life-"), "vibest.db")
  yield* Effect.void.pipe(Effect.provide(database(file)))
  yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [ledger] = yield* sql<{ value: string }>`SELECT value FROM meta WHERE key = 'ledger'`
    yield* sql`DELETE FROM migration WHERE id = ${MIGRATION}`
    yield* sql`UPDATE meta SET value = '5' WHERE key = 'catalog'`

    for (const [aggregate, seq, type, data] of oldFacts(ledger!.value))
      yield* sql`INSERT INTO event (aggregate, seq, at, type, data)
        VALUES (${aggregate}, ${seq}, ${seq}, ${type}, ${JSON.stringify(data)})`
  }).pipe(Effect.provide(Platform.sqlite(file)))

  return file
})

describe("execution lifecycle", () => {
  it.effect("keeps direct input off the inbox, shares one execution across messages, and does not reuse ids", () =>
    Effect.gen(function* () {
      const db = yield* withSession
      const sql = yield* SqlClient.SqlClient
      yield* db.session.startObserved(S, "typed line", 10)

      const [typed] = yield* sql<{ typed: string | null; started: number | null }>`SELECT typed, started_at AS started
        FROM execution WHERE session_id = ${S}`

      assert.strictEqual(typed?.typed, "typed line")
      assert.isNull(typed?.started)
      assert.strictEqual(
        (yield* sql<{ n: number }>`SELECT count(*) AS n FROM inbox WHERE content = 'typed line'`)[0]?.n,
        0,
      )
      yield* db.session.closeExecution(S, (yield* db.session.openExecution(S))!, "completed")

      const first = (yield* db.session.startExecution(S, 20)).execution
      const one = yield* db.inbox.insertSend(S, "one")
      const two = yield* db.inbox.insertSend(S, "two")
      assert.isDefined(one)
      assert.isDefined(two)
      yield* db.inbox.setInboxStatus(S, [one!.id, two!.id], "delivered", "pending", first)
      assert.deepStrictEqual(
        yield* sql<{ execution: number }>`SELECT execution_id AS execution FROM inbox
          WHERE session_id = ${S} AND kind = 'send' ORDER BY id`,
        [{ execution: first }, { execution: first }],
      )
      yield* db.session.closeExecution(S, first, "not_started")
      const second = (yield* db.session.startExecution(S, 30)).execution
      assert.strictEqual(second, first + 1)
      assert.strictEqual(
        (yield* sql<{ outcome: string }>`SELECT outcome FROM execution WHERE session_id = ${S} AND id = ${first}`)[0]
          ?.outcome,
        "not_started",
      )
    }).pipe(Effect.provide(memoryDb())),
  )

  it.effect("a stop that is not confirmed is not an interrupt, and a late report stays on the earlier execution", () =>
    Effect.gen(function* () {
      const db = yield* withSession
      const sql = yield* SqlClient.SqlClient
      const first = (yield* db.session.startExecution(S, 10)).execution
      yield* db.session.acceptExecution(S, first)
      yield* db.session.archive(S)
      assert.strictEqual(
        (yield* sql<{ outcome: string }>`SELECT outcome FROM execution WHERE session_id = ${S} AND id = ${first}`)[0]
          ?.outcome,
        "lost",
      )
      assert.strictEqual(
        (yield* sql<{ n: number }>`SELECT count(*) AS n FROM event WHERE type = 'execution.interrupted'`)[0]?.n,
        0,
      )
    }).pipe(Effect.provide(memoryDb())),
  )

  it.effect(
    "an end with no start leaves started_at empty, and a late report does not attach to the new execution",
    () =>
      Effect.gen(function* () {
        const db = yield* withSession
        const sql = yield* SqlClient.SqlClient
        assert.strictEqual(yield* db.session.endObserved(S, harnessEnd("completed", 20, "solo")), "completed")

        const [solo] = yield* sql<{ started: number | null; outcome: string; reply: string | null }>`SELECT
          started_at AS started, outcome, reply FROM execution WHERE session_id = ${S}`

        assert.strictEqual(solo?.outcome, "completed")
        assert.isNull(solo?.started)
        assert.strictEqual(solo?.reply, "solo")

        const first = (yield* db.session.startExecution(S, 30)).execution
        yield* db.session.acceptExecution(S, first)
        const successor = first + 1
        const bus = yield* Bus.Service
        yield* bus.transaction(
          Effect.gen(function* () {
            yield* bus.publish(Catalog["execution.allocated"], {
              sessionId: S,
              at: 40,
              data: { executionId: successor },
            })
            yield* bus.publish(Catalog["execution.started"], {
              sessionId: S,
              at: 41,
              data: { executionId: successor },
            })
          }),
        )
        assert.isUndefined(yield* db.session.endObserved(S, harnessEnd("completed", 50, "late")))

        const rows = yield* sql<{
          id: number
          outcome: string | null
          reply: string | null
          started: number | null
          owner: number
        }>`SELECT id, outcome, reply, started_at AS started, owner FROM execution
          WHERE session_id = ${S} AND id IN (${first}, ${successor}) ORDER BY id`

        assert.deepStrictEqual(rows, [
          { id: first, outcome: null, reply: null, started: rows[0]?.started ?? null, owner: 0 },
          { id: successor, outcome: null, reply: null, started: rows[1]?.started ?? null, owner: 1 },
        ])
        assert.notStrictEqual(rows[0]?.started, null)
        assert.notStrictEqual(rows[1]?.started, null)
        assert.strictEqual(yield* db.session.endObserved(S, harnessEnd("completed", 60, "again")), undefined)
        assert.strictEqual(
          (yield* sql<{
            n: number
          }>`SELECT count(*) AS n FROM event WHERE aggregate = ${S} AND type = 'execution.succeeded'`)[0]?.n,
          1,
        )
      }).pipe(Effect.provide(memoryDb())),
  )

  it.effect("a repeated end is idempotent, and a queued send still counts after its outbox row is deleted", () =>
    Effect.gen(function* () {
      const db = yield* withSession
      const sql = yield* SqlClient.SqlClient
      const execution = (yield* db.session.startExecution(S, 5)).execution
      yield* db.session.acceptExecution(S, execution)
      assert.strictEqual(yield* db.session.endObserved(S, harnessEnd("completed", 6, "once")), "completed")
      assert.strictEqual(yield* db.session.endObserved(S, harnessEnd("completed", 7, "once")), "completed")
      assert.strictEqual(
        (yield* sql<{
          n: number
        }>`SELECT count(*) AS n FROM event WHERE aggregate = ${S} AND type = 'execution.succeeded'`)[0]?.n,
        1,
      )

      const again = (yield* db.session.startExecution(S, 8)).execution
      const bus = yield* Bus.Service
      yield* bus.transaction(
        bus.publish(Catalog["outbox.queued"], {
          at: 9,
          data: {
            id: "66666666-6666-4666-8666-666666666661",
            peer: "55555555-5555-4555-8555-555555555555",
            session: S,
            kind: "send",
            content: "remote",
            execution: again,
          },
        }),
      )
      assert.strictEqual(yield* db.inbox.sentIn(S, again), 1)
      yield* bus.transaction(
        bus.publish(Catalog["outbox.queued"], {
          at: 10,
          data: {
            id: "66666666-6666-4666-8666-666666666662",
            peer: "55555555-5555-4555-8555-555555555555",
            session: S,
            content: "a notice",
          },
        }),
      )
      assert.strictEqual(yield* db.inbox.sentIn(S, again), 1)
      yield* db.session.archive(S)
      assert.strictEqual(yield* db.inbox.sentIn(S, again), 1)
      assert.strictEqual(
        (yield* sql<{ n: number }>`SELECT count(*) AS n FROM outbox WHERE session_id = ${S} AND kind = 'send'`)[0]?.n,
        1,
      )
    }).pipe(Effect.provide(memoryDb())),
  )

  it.effect("a lost execution's delayed answer does not complete the successor or allocate another", () =>
    Effect.gen(function* () {
      const db = yield* withSession
      const sql = yield* SqlClient.SqlClient
      const first = (yield* db.session.startExecution(S, 1)).execution
      yield* db.session.acceptExecution(S, first)
      yield* db.session.closeExecution(S, first, "lost", { failure: { message: "no end hook" } })
      const second = (yield* db.session.startExecution(S, 2)).execution
      yield* db.session.acceptExecution(S, second)
      assert.isUndefined(yield* db.session.endObserved(S, harnessEnd("completed", 3, "reply A")))
      assert.isUndefined(yield* db.session.endObserved(S, harnessEnd("completed", 4, "reply A")))
      assert.deepStrictEqual(
        yield* sql<{ id: number; outcome: string | null; reply: string | null }>`SELECT id, outcome, reply
          FROM execution WHERE session_id = ${S} ORDER BY id`,
        [
          { id: first, outcome: "lost", reply: null },
          { id: second, outcome: null, reply: null },
        ],
      )
      yield* db.session.startObserved(S, "second typed", 5)
      assert.strictEqual(
        (yield* sql<{
          n: number
        }>`SELECT count(*) AS n FROM event WHERE aggregate = ${S} AND data LIKE ${"%second typed%"}`)[0]?.n,
        1,
      )
      assert.notStrictEqual(
        (yield* sql<{
          started: number | null
        }>`SELECT started_at AS started FROM execution WHERE session_id = ${S} AND id = ${second}`)[0]?.started,
        null,
      )
    }).pipe(Effect.provide(memoryDb())),
  )

  it.effect(
    "an old log keeps execution ids, does not turn lost or not_started into failures, and keeps send counts",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const file = yield* oldLedger
        const before = yield* fs.readFile(file)

        const stored = yield* Layer.build(Platform.sqlite(file)).pipe(
          Effect.flatMap((context) => SqlClient.SqlClient.pipe(Effect.provide(context))),
        )

        const checked = yield* Effect.exit(
          checkLedger(stored).pipe(
            Effect.provide(Projectors.replay.pipe(Layer.provideMerge(Platform.sqlite(":memory:")))),
          ),
        )

        assert.isTrue(Exit.isSuccess(checked), String(checked))
        assert.deepStrictEqual(yield* fs.readFile(file), before)

        yield* open().pipe(Effect.provide(runner(file)))

        const read = <A extends object>(query: string) =>
          Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe<A>(query)).pipe(Effect.provide(Platform.sqlite(file)))

        assert.deepStrictEqual(
          yield* read(
            "SELECT id, outcome, typed, started_at AS started FROM execution WHERE session_id = '" +
              S +
              "' ORDER BY id",
          ),
          [
            { id: 3, outcome: "completed", typed: "typed line", started: null },
            { id: 6, outcome: "lost", typed: null, started: null },
            { id: 8, outcome: "not_started", typed: null, started: null },
          ],
        )

        const sent = yield* read<{ sent: number }>(
          `SELECT (SELECT count(*) FROM inbox WHERE sender_session_id = '${S}' AND kind = 'send' AND sender_execution_id = 3) + (SELECT count(*) FROM outbox WHERE session_id = '${S}' AND kind = 'send' AND execution_id = 3) AS sent`,
        )

        assert.strictEqual(sent[0]?.sent, 2)

        const names = yield* read<{ type: string }>(
          "SELECT type FROM event WHERE type LIKE 'execution.%' ORDER BY position",
        )

        assert.deepStrictEqual(
          names.map((row) => row.type),
          [
            "execution.allocated",
            "execution.succeeded",
            "execution.allocated",
            "execution.unresolved",
            "execution.allocated",
            "execution.unresolved",
          ],
        )

        const catalog = yield* read<{ catalog: string; applied: number }>(
          `SELECT (SELECT value FROM meta WHERE key = 'catalog') AS catalog, (SELECT count(*) FROM migration WHERE id = '${MIGRATION}') AS applied`,
        )

        assert.deepStrictEqual(catalog, [{ catalog: String(CATALOG_VERSION), applied: 1 }])

        const conversation = yield* read<{ conversation: string | null }>(
          `SELECT conversation FROM process WHERE session_id = '${S}' AND id = 2`,
        )

        assert.strictEqual(conversation[0]?.conversation, "conv-1")
      }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )
})
