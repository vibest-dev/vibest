import { assert, describe, it } from "@effect/vitest"
import { checkLedger, open } from "@vibest/core/database/migration"
import * as Projectors from "@vibest/core/database/projectors"
import { tempDirectory } from "@vibest/platform-bun/test/lib/fakes"
import { database } from "@vibest/platform-bun/test/lib/unit-helpers"
import { Effect, Exit, FileSystem, Layer, Path } from "effect"
import { SqlClient } from "effect/sql"

import * as Platform from "#platform"

const P = "11111111-1111-4111-8111-111111111111"
const A = "22222222-2222-4222-8222-222222222222"
const B = "33333333-3333-4333-8333-333333333333"
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
  it.effect(
    "keeps a confirmed handoff only when the old move names an execution, leaves the rest unresolved, and import-check does not change the file",
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

        const events = yield* read<{ seq: number; type: string; data: string }>(
          file,
          (sql) => sql`SELECT seq, type, data FROM event WHERE aggregate = ${B} AND type LIKE 'inbox.%' ORDER BY seq`,
        )

        assert.deepStrictEqual(
          events.map((row) => [row.seq, row.type, JSON.parse(row.data)]),
          [
            [2, "inbox.enqueued", { sender: agent, content: "review", requestId: "run-1" }],
            [4, "inbox.delivered", { messageId: 2, recipientExecutionId: 3 }],
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
              status: "delivered",
              request: "run-1",
              transferId: null,
              senderExecutionId: null,
              recipientExecutionId: 3,
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
          ],
        )
        assert.deepStrictEqual(yield* read(file, (sql) => sql`SELECT id, message_id FROM session WHERE id = ${B}`), [
          { id: B, messageId: 2 },
        ])
        assert.deepStrictEqual(
          yield* read(file, (sql) => sql`SELECT id, sent FROM execution WHERE session_id = ${A}`),
          [{ id: 2, sent: 1 }],
        )
      }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )
})
