import { assert, describe, it } from "@effect/vitest"
import { Bus } from "@vibest/core/bus"
import { Db } from "@vibest/core/database/db"
import { checkLedger, open } from "@vibest/core/database/migration"
import * as Projectors from "@vibest/core/database/projectors"
import { SessionLive } from "@vibest/core/session/live"
import { tempDirectory } from "@vibest/platform-bun/test/lib/fakes"
import { database, session } from "@vibest/platform-bun/test/lib/unit-helpers"
import { Effect, Exit, FileSystem, Layer, Path } from "effect"
import { SqlClient } from "effect/sql"

import * as Platform from "#platform"

const P = "11111111-1111-4111-8111-111111111111"
const A = "22222222-2222-4222-8222-222222222222"
const B = "33333333-3333-4333-8333-333333333333"
const R = "44444444-4444-4444-8444-444444444444"
const E = "55555555-5555-4555-8555-555555555555"
const C = "66666666-6666-4666-8666-666666666666"
const L = "77777777-7777-4777-8777-777777777777"
const MIGRATION = "20261121000000_inbox_v1"

const agent = { type: "agent" as const, session: A }

const facts = [
  [P, 1, "project.created", { directory: "/p", repositories: [] }],
  [A, 1, "session.created", { project: P, agent: "general", name: "a", directory: "/p" }],
  [A, 2, "execution.started", {}],
  [B, 1, "session.created", { project: P, agent: "general", name: "b", directory: "/p/b", parent: A }],
  [B, 2, "inbox.queued", { kind: "task", sender: agent, content: "review", status: "delivered", request: "run-1" }],
  [B, 3, "execution.started", {}],
  [B, 4, "inbox.moved", { inbox: 2, to: "delivered", execution: 3 }],
  [
    B,
    5,
    "inbox.queued",
    { kind: "send", sender: agent, content: "later", status: "pending", execution: 2, request: "s-1" },
  ],
  [B, 6, "inbox.moved", { inbox: 5, to: "delivering" }],
  [B, 7, "inbox.queued", { kind: "send", sender: agent, content: "no execution", status: "pending" }],
  [B, 8, "inbox.moved", { inbox: 7, to: "delivered" }],
  [B, 9, "inbox.queued", { kind: "send", sender: agent, content: "broke", status: "pending" }],
  [B, 10, "inbox.moved", { inbox: 9, to: "failed" }],
  [B, 11, "inbox.queued", { kind: "send", sender: agent, content: "waiting", status: "pending" }],
  [B, 12, "inbox.moved", { inbox: 11, to: "dropped" }],
  [
    B,
    13,
    "inbox.queued",
    { kind: "send", sender: agent, content: "routed", status: "dropped", peerItem: "item-1", request: "route-1" },
  ],
  [B, 14, "execution.accepted", { execution: 3 }],
  [B, 15, "inbox.queued", { kind: "send", sender: agent, content: "booked", status: "pending" }],
  [B, 16, "inbox.moved", { inbox: 15, to: "delivered", execution: 99 }],
  [R, 1, "session.created", { project: P, agent: "general", name: "r", directory: "/p" }],
  [R, 3, "inbox.queued", { kind: "send", sender: { type: "user" }, content: "cut", status: "pending" }],
  [R, 4, "inbox.moved", { inbox: 3, to: "delivering" }],
  [R, 5, "inbox.moved", { inbox: 3, to: "pending" }],
  [E, 1, "session.created", { project: P, agent: "general", name: "entry", directory: "/p" }],
  [E, 2, "execution.ended", { execution: 1, outcome: "completed" }],
  [E, 3, "process.ended", { process: 1, reason: "exited" }],
  [E, 5, "inbox.queued", { kind: "task", sender: { type: "user" }, content: "later bootstrap", status: "delivered" }],
  [E, 6, "execution.started", {}],
  [E, 7, "inbox.moved", { inbox: 5, to: "delivered", execution: 6 }],
  [C, 1, "session.created", { project: P, agent: "general", name: "c", directory: "/p", parent: A }],
  [
    C,
    2,
    "inbox.queued",
    { kind: "task", sender: agent, content: "wait no launch", status: "delivered", request: "delegation" },
  ],
  [C, 3, "execution.started", {}],
  [C, 4, "inbox.moved", { inbox: 2, to: "delivered", execution: 3 }],
  [C, 5, "execution.ended", { execution: 3, outcome: "interrupted" }],
  [L, 1, "session.created", { project: P, agent: "general", name: "limit", directory: "/p", parent: A }],
  [L, 2, "process.started", { harness: "pi", runtime: "herdr", terminal: "t" }],
  [
    L,
    3,
    "inbox.queued",
    { kind: "task", sender: agent, content: "rejected open", status: "delivered", request: "r2-launch" },
  ],
  [L, 4, "execution.started", {}],
  [L, 5, "inbox.moved", { inbox: 3, to: "delivered", execution: 4 }],
  [L, 6, "execution.ended", { execution: 4, outcome: "failed" }],
] as const

const runner = (file: string) => Projectors.replay.pipe(Layer.provideMerge(Platform.sqlite(file)))

const oldLedger = Effect.gen(function* () {
  const path = yield* Path.Path
  const file = path.join(yield* tempDirectory("vibest-inbox-v1-"), "vibest.db")
  yield* Effect.void.pipe(Effect.provide(database(file)))
  yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`DELETE FROM migration WHERE id = ${MIGRATION}`
    yield* sql`UPDATE meta SET value = '5' WHERE key = 'catalog'`

    for (const [aggregate, seq, type, data] of facts)
      yield* sql`INSERT INTO event (aggregate, seq, at, type, data)
        VALUES (${aggregate}, ${seq}, ${seq}, ${type}, ${JSON.stringify(data)})`
  }).pipe(Effect.provide(Platform.sqlite(file)))

  return file
})

const read = <A extends object>(
  file: string,
  query: (sql: SqlClient.SqlClient) => Effect.Effect<ReadonlyArray<A>, unknown>,
) => Effect.flatMap(SqlClient.SqlClient, query).pipe(Effect.provide(Platform.sqlite(file)))

describe("ledger migration 20261121000000_inbox_v1", () => {
  it.effect("keeps an old requeue and its seq, and does not turn an execution id into delivery", () =>
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

      const events = yield* read<{ seq: number; type: string; data: string }>(
        file,
        (sql) => sql`SELECT seq, type, data FROM event WHERE aggregate = ${B} AND type LIKE 'inbox.%' ORDER BY seq`,
      )

      assert.deepStrictEqual(
        events.map((row) => [row.seq, row.type, JSON.parse(row.data)]),
        [
          [2, "inbox.enqueued", { sender: agent, content: "review", requestId: "run-1" }],
          [4, "inbox.unresolved", { history: "unconfirmed", messageId: 2, execution: 3 }],
          [5, "inbox.enqueued", { sender: agent, content: "later", senderExecutionId: 2, requestId: "s-1" }],
          [6, "inbox.delivery_started", { messageId: 5 }],
          [7, "inbox.enqueued", { sender: agent, content: "no execution" }],
          [8, "inbox.unresolved", { history: "delivered_without_execution", messageId: 7 }],
          [9, "inbox.enqueued", { sender: agent, content: "broke" }],
          [10, "inbox.unresolved", { history: "failed_unspecified", messageId: 9 }],
          [11, "inbox.enqueued", { sender: agent, content: "waiting" }],
          [12, "inbox.dropped", { messageId: 11, reason: "unrecorded" }],
          [
            13,
            "inbox.unresolved",
            { history: "route", sender: agent, content: "routed", transferId: "item-1", requestId: "route-1" },
          ],
          [15, "inbox.enqueued", { sender: agent, content: "booked" }],
          [16, "inbox.unresolved", { history: "unconfirmed", messageId: 15, execution: 99 }],
        ],
      )
      assert.deepStrictEqual(
        yield* read(
          file,
          (sql) =>
            sql`SELECT id, status, request, transfer_id, sender_execution_id, recipient_execution_id
                FROM inbox WHERE session_id = ${B} ORDER BY id`,
        ),
        [
          {
            id: 2,
            status: "unresolved",
            request: "run-1",
            transferId: null,
            senderExecutionId: null,
            recipientExecutionId: null,
          },
          {
            id: 5,
            status: "delivering",
            request: "s-1",
            transferId: null,
            senderExecutionId: 2,
            recipientExecutionId: null,
          },
          {
            id: 7,
            status: "unresolved",
            request: null,
            transferId: null,
            senderExecutionId: null,
            recipientExecutionId: null,
          },
          {
            id: 9,
            status: "unresolved",
            request: null,
            transferId: null,
            senderExecutionId: null,
            recipientExecutionId: null,
          },
          {
            id: 11,
            status: "dropped",
            request: null,
            transferId: null,
            senderExecutionId: null,
            recipientExecutionId: null,
          },
          {
            id: 13,
            status: "unresolved",
            request: "route-1",
            transferId: "item-1",
            senderExecutionId: null,
            recipientExecutionId: null,
          },
          {
            id: 15,
            status: "unresolved",
            request: null,
            transferId: null,
            senderExecutionId: null,
            recipientExecutionId: null,
          },
        ],
      )
      assert.deepStrictEqual(yield* read(file, (sql) => sql`SELECT id, message_id FROM session WHERE id = ${B}`), [
        { id: B, messageId: 2 },
      ])
      assert.deepStrictEqual(
        yield* read(file, (sql) => sql`SELECT seq, type FROM event WHERE aggregate = ${R} AND seq = 5`),
        [{ seq: 5, type: "inbox.unresolved" }],
      )
      assert.deepStrictEqual(yield* read(file, (sql) => sql`SELECT id, status FROM inbox WHERE session_id = ${R}`), [
        { id: 3, status: "pending" },
      ])
      assert.deepStrictEqual(
        yield* read(file, (sql) => sql`SELECT max(seq) AS seq FROM event WHERE aggregate = ${R}`),
        [{ seq: 5 }],
      )

      const next = yield* Effect.gen(function* () {
        const db = yield* Db.Service

        return yield* db.inbox.insertSend(R, "after the requeue", { type: "user" })
      }).pipe(
        Effect.provide(
          Db.layer.pipe(
            Layer.provide(Projectors.layer),
            Layer.provide(Bus.layer),
            Layer.provide(SessionLive.layer),
            Layer.provideMerge(Platform.sqlite(file)),
          ),
        ),
      )

      assert.strictEqual(next?.id, 6)
      assert.deepStrictEqual(yield* read(file, (sql) => sql`SELECT message_id FROM session WHERE id = ${E}`), [
        { messageId: null },
      ])
      assert.deepStrictEqual(
        yield* read(file, (sql) => sql`SELECT id, status, recipient_execution_id FROM inbox WHERE session_id = ${E}`),
        [{ id: 5, status: "unresolved", recipientExecutionId: null }],
      )
      assert.deepStrictEqual(
        yield* read(file, (sql) => sql`SELECT status, recipient_execution_id FROM inbox WHERE session_id = ${C}`),
        [{ status: "unresolved", recipientExecutionId: null }],
      )
      assert.deepStrictEqual(yield* read(file, (sql) => sql`SELECT message_id FROM session WHERE id = ${C}`), [
        { messageId: 2 },
      ])
      assert.deepStrictEqual(yield* read(file, (sql) => sql`SELECT message_id FROM session WHERE id = ${L}`), [
        { messageId: 3 },
      ])
      assert.deepStrictEqual(yield* read(file, (sql) => sql`SELECT status FROM inbox WHERE session_id = ${L}`), [
        { status: "unresolved" },
      ])

      const retry = yield* Effect.gen(function* () {
        const db = yield* Db.Service

        return yield* db.session.insertSession(session("88888888-8888-4888-8888-888888888888"), P, {
          cwd: "/p",
          task: "again",
          request: "r2-launch",
          parentSessionId: A,
        })
      }).pipe(
        Effect.provide(
          Db.layer.pipe(
            Layer.provide(Projectors.layer),
            Layer.provide(Bus.layer),
            Layer.provide(SessionLive.layer),
            Layer.provideMerge(Platform.sqlite(file)),
          ),
        ),
      )

      if (retry === true || retry === "waiting" || retry === "parent-ended") return yield* Effect.die(retry)

      assert.strictEqual(retry.id, L)
      assert.deepStrictEqual(yield* read(file, (sql) => sql`SELECT id, sent FROM execution WHERE session_id = ${A}`), [
        { id: 2, sent: 1 },
      ])
    }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )
})
