import { assert, describe, it } from "@effect/vitest"
import { Bus } from "@vibest/core/bus"
import { Db } from "@vibest/core/database/db"
import * as Projectors from "@vibest/core/database/projectors"
import { SessionLive } from "@vibest/core/session/live"
import { projectOf } from "@vibest/platform-bun/test/lib/fakes"
import { session } from "@vibest/platform-bun/test/lib/unit-helpers"
import { MachineEvent } from "@vibest/schema/machine-event"
import { SessionEvent } from "@vibest/schema/session-event"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"

import * as Platform from "#platform"

const S = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"

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

const harnessEnd = (status: "completed" | "failed" | "interrupted", at: number, reply = "", execution?: number) => ({
  harness: "pi" as const,
  at,
  status,
  reply,
  failure: status === "failed" ? "boom" : undefined,
  limited: false,
  conversation: undefined,
  needsReady: false,
  ...(execution !== undefined && { execution }),
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
        yield* sql<{ execution: number }>`SELECT recipient_execution_id AS execution FROM inbox m
          WHERE m.recipient_session_id = ${S}
            AND NOT EXISTS (SELECT 1 FROM session s WHERE s.id = m.recipient_session_id AND s.message_id = m.id)
          ORDER BY m.id`,
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
        (yield* sql<{ n: number }>`SELECT count(*) AS n FROM event WHERE type = 'session.execution.interrupted.1'`)[0]
          ?.n,
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
        assert.isUndefined(yield* db.session.endObserved(S, harnessEnd("completed", 20, "solo")))
        assert.strictEqual(
          (yield* sql<{ n: number }>`SELECT count(*) AS n FROM execution WHERE session_id = ${S}`)[0]?.n,
          0,
        )

        const first = (yield* db.session.startExecution(S, 30)).execution
        yield* db.session.acceptExecution(S, first)
        assert.strictEqual(yield* db.session.endObserved(S, harnessEnd("completed", 31, "same", first)), "completed")
        const successor = first + 1
        const bus = yield* Bus.Service
        yield* bus.transaction(
          Effect.gen(function* () {
            yield* bus.publish(SessionEvent.ExecutionAllocated, { sessionId: S, executionId: successor }, { at: 40 })
            yield* bus.publish(SessionEvent.ExecutionStarted, { sessionId: S, executionId: successor }, { at: 41 })
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
          { id: first, outcome: "completed", reply: "same", started: rows[0]?.started ?? null, owner: 0 },
          { id: successor, outcome: null, reply: null, started: rows[1]?.started ?? null, owner: 1 },
        ])
        assert.strictEqual(
          yield* db.session.endObserved(S, harnessEnd("completed", 60, "same", successor)),
          "completed",
        )
        assert.strictEqual(
          (yield* sql<{ reply: string }>`SELECT reply FROM execution WHERE session_id = ${S} AND id = ${first}`)[0]
            ?.reply,
          "same",
        )
        assert.strictEqual(
          (yield* sql<{
            n: number
          }>`SELECT count(*) AS n FROM event WHERE aggregate_id = ${S} AND type = 'session.execution.succeeded.1'`)[0]
            ?.n,
          2,
        )
      }).pipe(Effect.provide(memoryDb())),
  )

  it.effect("a repeated end is idempotent, and a queued send still counts after its outbox row is deleted", () =>
    Effect.gen(function* () {
      const db = yield* withSession
      const sql = yield* SqlClient.SqlClient
      const execution = (yield* db.session.startExecution(S, 5)).execution
      yield* db.session.acceptExecution(S, execution)
      assert.strictEqual(yield* db.session.endObserved(S, harnessEnd("completed", 6, "once", execution)), "completed")
      assert.strictEqual(yield* db.session.endObserved(S, harnessEnd("completed", 7, "once", execution)), "completed")
      assert.strictEqual(
        (yield* sql<{
          n: number
        }>`SELECT count(*) AS n FROM event WHERE aggregate_id = ${S} AND type = 'session.execution.succeeded.1'`)[0]?.n,
        1,
      )

      const again = (yield* db.session.startExecution(S, 8)).execution
      const bus = yield* Bus.Service
      yield* bus.transaction(
        bus.publish(
          MachineEvent.OutboxQueued,
          {
            id: "66666666-6666-4666-8666-666666666661",
            remoteId: "55555555-5555-4555-8555-555555555555",
            session: S,
            kind: "send",
            content: "remote",
            execution: again,
          },
          { at: 9 },
        ),
      )
      assert.strictEqual(yield* db.inbox.sentIn(S, again), 1)
      yield* bus.transaction(
        bus.publish(
          MachineEvent.OutboxQueued,
          {
            id: "66666666-6666-4666-8666-666666666662",
            remoteId: "55555555-5555-4555-8555-555555555555",
            session: S,
            content: "a notice",
          },
          { at: 10 },
        ),
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
      yield* db.session.setStatus(S, "working")
      assert.isUndefined(
        yield* db.session.endObserved(S, { ...harnessEnd("completed", 3, "reply A"), conversation: "conv-ambig" }),
      )
      assert.isUndefined(yield* db.session.endObserved(S, harnessEnd("completed", 4, "reply A")))
      const afterAmbiguous = (yield* db.session.getSession(S))!
      assert.strictEqual(afterAmbiguous.status, "idle")
      assert.strictEqual(afterAmbiguous.process?.harnessSessionId, "conv-ambig")
      assert.strictEqual(
        (yield* sql<{
          n: number
        }>`SELECT count(*) AS n FROM event WHERE aggregate_id = ${S} AND type = 'session.execution.succeeded.1'`)[0]?.n,
        0,
      )
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
        }>`SELECT count(*) AS n FROM event WHERE aggregate_id = ${S} AND data LIKE ${"%second typed%"}`)[0]?.n,
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
    "unkeyed end settles sole active owned execution without faking started_at, and unowned unkeyed end only updates conversation and idle status",
    () =>
      Effect.gen(function* () {
        const db = yield* withSession
        const sql = yield* SqlClient.SqlClient
        yield* db.session.setStatus(S, "working")
        assert.isUndefined(
          yield* db.session.endObserved(S, { ...harnessEnd("completed", 5, "unowned"), conversation: "conv-unowned" }),
        )
        const unowned = (yield* db.session.getSession(S))!
        assert.strictEqual(unowned.status, "idle")
        assert.strictEqual(unowned.process?.harnessSessionId, "conv-unowned")
        assert.strictEqual(
          (yield* sql<{
            n: number
          }>`SELECT count(*) AS n FROM event WHERE aggregate_id = ${S} AND type = 'session.execution.succeeded.1'`)[0]
            ?.n,
          0,
        )

        const sole = (yield* db.session.startExecution(S, 10)).execution
        yield* db.session.setStatus(S, "working")
        assert.strictEqual(
          yield* db.session.endObserved(S, { ...harnessEnd("completed", 11, "sole reply"), conversation: "conv-sole" }),
          "completed",
        )
        const settled = (yield* db.session.getSession(S))!
        assert.strictEqual(settled.status, "idle")
        assert.strictEqual(settled.process?.harnessSessionId, "conv-sole")

        const [row] = yield* sql<{
          id: number
          outcome: string | null
          reply: string | null
          started: number | null
          owner: number
        }>`SELECT id, outcome, reply, started_at AS started, owner FROM execution WHERE session_id = ${S} AND id = ${sole}`

        assert.deepStrictEqual(row, {
          id: sole,
          outcome: "completed",
          reply: "sole reply",
          started: null,
          owner: 0,
        })

        const second = (yield* db.session.startExecution(S, 12)).execution
        yield* db.session.setStatus(S, "working")
        assert.strictEqual(
          yield* db.session.endObserved(S, { ...harnessEnd("completed", 13, "sole reply"), conversation: "conv-2" }),
          "completed",
        )
        const settledSecond = (yield* db.session.getSession(S))!
        assert.strictEqual(settledSecond.status, "idle")
        assert.strictEqual(settledSecond.process?.harnessSessionId, "conv-2")

        const [secondRow] = yield* sql<{
          id: number
          outcome: string | null
          reply: string | null
          owner: number
        }>`SELECT id, outcome, reply, owner FROM execution WHERE session_id = ${S} AND id = ${second}`

        assert.deepStrictEqual(secondRow, {
          id: second,
          outcome: "completed",
          reply: "sole reply",
          owner: 0,
        })

        const eventsBeforeReplay = (yield* sql<{
          n: number
        }>`SELECT count(*) AS n FROM event WHERE aggregate_id = ${S}`)[0]?.n

        assert.strictEqual(yield* db.session.endObserved(S, harnessEnd("completed", 14, "sole reply")), "completed")
        assert.strictEqual(
          (yield* sql<{ n: number }>`SELECT count(*) AS n FROM event WHERE aggregate_id = ${S}`)[0]?.n,
          eventsBeforeReplay,
        )
      }).pipe(Effect.provide(memoryDb())),
  )
})
