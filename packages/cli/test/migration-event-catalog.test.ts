import { assert, describe, it } from "@effect/vitest"
import { Bus } from "@vibest/core/bus"
import { Db } from "@vibest/core/database/db"
import { checkLedger, open } from "@vibest/core/database/migration"
import * as Projectors from "@vibest/core/database/projectors"
import * as PluginHost from "@vibest/core/plugin/host"
import { SessionLive } from "@vibest/core/session/live"
import { tempDirectory } from "@vibest/platform-bun/test/lib/fakes"
import { database } from "@vibest/platform-bun/test/lib/unit-helpers"
import { Catalog, PublicCatalog } from "@vibest/schema/event"
import { canonicalTarget } from "@vibest/schema/terminal"
import { Effect, Exit, Fiber, Layer, Path, Stream } from "effect"
import { SqlClient } from "effect/sql"

import * as Platform from "#platform"

const P = "11111111-1111-4111-8111-111111111111"
const S = "22222222-2222-4222-8222-222222222222"
const R = "33333333-3333-4333-8333-333333333333"
const REMOTE = "44444444-4444-4444-8444-444444444444"
const ITEM_1 = "55555555-5555-4555-8555-555555555551"
const ITEM_2 = "55555555-5555-4555-8555-555555555552"
const MIGRATION = "20261124050000_clean_event_catalog"

const runner = (file: string) => Projectors.replay.pipe(Layer.provideMerge(Platform.sqlite(file)))

const assertCheckLedger = (file: string) =>
  Effect.gen(function* () {
    const stored = yield* Layer.build(Platform.sqlite(file)).pipe(
      Effect.flatMap((context) => SqlClient.SqlClient.pipe(Effect.provide(context))),
    )

    const checked = yield* Effect.exit(
      checkLedger(stored).pipe(Effect.provide(Projectors.replay.pipe(Layer.provideMerge(Platform.sqlite(":memory:"))))),
    )

    assert.isTrue(Exit.isSuccess(checked), String(checked))
  }).pipe(Effect.scoped)

describe("ledger migration 20261124050000_clean_event_catalog", () => {
  it.effect(
    "remaps non-identity seq shifts across message, process, processId, and messageId, merges process.updated, rewrites hook names, and passes checkLedger",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path
        const file = path.join(yield* tempDirectory("vibest-clean-catalog-"), "vibest.db")
        yield* Effect.void.pipe(Effect.provide(database(file)))

        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const [ledgerRow] = yield* sql<{ value: string }>`SELECT value FROM meta WHERE key = 'ledger'`
          const ledger = ledgerRow!.value

          yield* sql`DELETE FROM migration WHERE id >= ${MIGRATION}`
          yield* sql`UPDATE meta SET value = '15' WHERE key = 'catalog'`

          const legacyFacts = [
            [P, 1, 1, "project.created", { directory: "/p", repositories: [] }],
            [ledger, 1, 2, "remote.seen", { id: REMOTE, name: "box" }],
            [ledger, 2, 3, "outbox.queued", { id: ITEM_1, remote: REMOTE, session: S, content: "one" }],
            [ledger, 3, 4, "outbox.queued", { id: ITEM_2, remote: REMOTE, session: S, kind: "send", content: "two" }],
            [ledger, 4, 5, "outbox.acked", { remote: REMOTE, ids: [ITEM_1] }],
            [S, 1, 10, "execution.accepted", { execution: 1 }],
            [S, 2, 11, "execution.accepted", { execution: 2 }],
            [S, 3, 12, "inbox.enqueued", { sender: { type: "user" }, content: "delegation" }],
            [S, 4, 13, "session.created", { project: P, agent: "general", name: "sub", directory: "/p/s", message: 3 }],
            [
              S,
              5,
              14,
              "process.started",
              {
                harness: "pi",
                runtime: "herdr",
                routing: {
                  decidedBy: { harness: "p1" },
                  trace: [{ plugin: "p1", hook: "agent.start.before", outcome: "ok", ms: 1, changes: [] }],
                },
              },
            ],
            [S, 6, 15, "process.placed", { process: 5, terminal: { id: "t1" }, pid: 100 }],
            [S, 7, 16, "process.pid", { process: 5, pid: 101 }],
            [S, 8, 17, "process.conversation", { process: 5, conversation: "conv-1" }],
            [S, 9, 18, "process.ready", { process: 5, pid: 102 }],
            [S, 10, 19, "execution.allocated", { executionId: 1, processId: 5 }],
            [S, 11, 20, "execution.started", { executionId: 1, processId: 5 }],
            [S, 12, 21, "inbox.delivery_started", { messageId: 3, execution: 1 }],
            [S, 13, 22, "inbox.delivered", { messageId: 3, recipientExecutionId: 1 }],
            [S, 14, 23, "execution.succeeded", { executionId: 1, reply: "ok" }],
            [
              S,
              15,
              24,
              "inbox.unresolved",
              { history: "route", sender: { type: "user" }, content: "routed", requestId: "req-route" },
            ],
            [S, 16, 25, "inbox.enqueued", { sender: { type: "user" }, content: "failed-msg" }],
            [S, 17, 26, "inbox.unresolved", { history: "failed_unspecified", messageId: 16 }],
            [S, 18, 27, "inbox.enqueued", { sender: { type: "user" }, content: "unconfirmed-msg" }],
            [S, 19, 28, "inbox.unresolved", { history: "unconfirmed", messageId: 18 }],
            [S, 20, 29, "process.ended", { process: 5, reason: "archived" }],
            [S, 21, 30, "session.ended", { reason: "archived" }],
            [R, 1, 31, "session.created", { project: P, agent: "general", name: "rel", directory: "/p/r" }],
            [R, 2, 32, "inbox.enqueued", { sender: { type: "user" }, content: "released-pending" }],
            [R, 3, 33, "inbox.delivery_started", { messageId: 2, execution: 1 }],
            [R, 4, 34, "inbox.unresolved", { history: "released", messageId: 2 }],
          ] as const

          for (const [aggregate, seq, at, type, data] of legacyFacts)
            yield* sql`INSERT INTO event (aggregate, seq, at, type, data)
              VALUES (${aggregate}, ${seq}, ${at}, ${type}, ${JSON.stringify(data)})`
        }).pipe(Effect.provide(Platform.sqlite(file)))

        yield* assertCheckLedger(file)
        yield* open().pipe(Effect.provide(runner(file)))
        yield* assertCheckLedger(file)

        const projected = yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient

          const [sess] = yield* sql<{
            messageId: number | null
            processId: number | null
            endedAt: number | null
          }>`SELECT message_id, process_id, ended_at FROM session WHERE id = ${S}`

          const [proc] = yield* sql<{
            id: number
            terminal: string | null
            placedAt: number | null
            pid: number | null
            harnessSessionId: string | null
            routing: string | null
            endedAt: number | null
          }>`SELECT id, terminal, placed_at, pid, harness_session_id, routing, ended_at FROM process WHERE session_id = ${S}`

          const [exec] = yield* sql<{
            id: number
            processId: number | null
            outcome: string | null
          }>`SELECT id, process_id, outcome FROM execution WHERE session_id = ${S}`

          const inboxS = yield* sql<{
            id: number
            content: string
            status: string
            recipientExecutionId: number | null
          }>`SELECT id, content, status, recipient_execution_id FROM inbox WHERE recipient_session_id = ${S} ORDER BY id`

          const inboxR = yield* sql<{
            id: number
            status: string
            recipientExecutionId: number | null
          }>`SELECT id, status, recipient_execution_id FROM inbox WHERE recipient_session_id = ${R} ORDER BY id`

          const outbox = yield* sql<{ id: string; seq: number; ackedAt: number | null }>`SELECT id, seq, acked_at
            FROM outbox ORDER BY seq`

          return { sess, proc, exec, inboxS, inboxR, outbox }
        }).pipe(Effect.provide(Platform.sqlite(file)))

        assert.deepStrictEqual(projected.sess, { messageId: 1, processId: 3, endedAt: 30 })
        assert.strictEqual(projected.proc?.id, 3)
        assert.strictEqual(projected.proc?.terminal, canonicalTarget({ id: "t1" }))
        assert.strictEqual(projected.proc?.placedAt, 15)
        assert.strictEqual(projected.proc?.pid, 102)
        assert.strictEqual(projected.proc?.harnessSessionId, "conv-1")
        assert.strictEqual(projected.proc?.endedAt, 29)
        assert.strictEqual(JSON.parse(projected.proc?.routing ?? "{}").trace[0].hook, "session.start.before")
        assert.deepStrictEqual(projected.exec, { id: 1, processId: 3, outcome: "completed" })
        assert.deepStrictEqual(projected.inboxS, [
          { id: 1, content: "delegation", status: "delivered", recipientExecutionId: 1 },
          { id: 13, content: "routed", status: "dropped", recipientExecutionId: null },
          { id: 15, content: "failed-msg", status: "failed", recipientExecutionId: null },
          { id: 17, content: "unconfirmed-msg", status: "dropped", recipientExecutionId: null },
        ])
        assert.deepStrictEqual(projected.inboxR, [{ id: 2, status: "pending", recipientExecutionId: null }])
        assert.deepStrictEqual(projected.outbox, [
          { id: ITEM_1, seq: 2, ackedAt: 5 },
          { id: ITEM_2, seq: 3, ackedAt: null },
        ])
      }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )

  for (const mode of ["in-place-delete", "route-expansion"] as const) {
    it.effect(
      `preserves cross-aggregate event.position order for project.moved and post-archive outbox.queued (${mode})`,
      () =>
        Effect.gen(function* () {
          const path = yield* Path.Path
          const file = path.join(yield* tempDirectory(`vibest-clean-order-${mode}-`), "vibest.db")
          yield* Effect.void.pipe(Effect.provide(database(file)))

          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            const [ledgerRow] = yield* sql<{ value: string }>`SELECT value FROM meta WHERE key = 'ledger'`
            const ledger = ledgerRow!.value

            yield* sql`DELETE FROM migration WHERE id >= ${MIGRATION}`
            yield* sql`UPDATE meta SET value = '15' WHERE key = 'catalog'`

            const restructuringFact =
              mode === "in-place-delete"
                ? ([S, 2, 3, "execution.accepted", { execution: 1 }] as const)
                : ([S, 2, 3, "inbox.unresolved", { history: "route", sender: { type: "user" }, content: "r" }] as const)

            const interleaved = [
              [P, 1, 1, "project.created", { directory: "/old", repositories: [] }],
              [S, 1, 2, "session.created", { project: P, agent: "general", name: "sub", directory: "/old/work" }],
              restructuringFact,
              [S, 3, 4, "session.ended", { reason: "archived" }],
              [P, 2, 5, "project.moved", { from: "/old", to: "/new", repositories: [] }],
              [
                ledger,
                1,
                6,
                "outbox.queued",
                { id: ITEM_1, remote: REMOTE, session: S, kind: "send", content: "forwarded" },
              ],
            ] as const

            for (const [aggregate, seq, at, type, data] of interleaved)
              yield* sql`INSERT INTO event (aggregate, seq, at, type, data)
                VALUES (${aggregate}, ${seq}, ${at}, ${type}, ${JSON.stringify(data)})`
          }).pipe(Effect.provide(Platform.sqlite(file)))

          yield* assertCheckLedger(file)
          yield* open().pipe(Effect.provide(runner(file)))
          yield* assertCheckLedger(file)

          const { sessionDirectory, outboxRemoteId } = yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            const [sess] = yield* sql<{ directory: string }>`SELECT directory FROM session WHERE id = ${S}`
            const [out] = yield* sql<{ remoteId: string }>`SELECT remote_id FROM outbox WHERE id = ${ITEM_1}`

            return { sessionDirectory: sess?.directory, outboxRemoteId: out?.remoteId }
          }).pipe(Effect.provide(Platform.sqlite(file)))

          assert.strictEqual(sessionDirectory, "/new/work")
          assert.strictEqual(outboxRemoteId, REMOTE)
        }).pipe(Effect.scoped, Effect.provide(Platform.services)),
    )
  }

  it.effect("noteRemote deduplicates unchanged remote.seen and publishes when name changes", () =>
    Effect.gen(function* () {
      const db = yield* Db.Service
      const sql = yield* SqlClient.SqlClient

      yield* db.remote.noteRemote({ id: REMOTE, name: "box" })
      yield* db.remote.noteRemote({ id: REMOTE, name: "box" })
      yield* db.remote.noteRemote({ id: REMOTE, name: "box" })

      const firstCount = yield* sql<{ n: number }>`SELECT count(*) AS n FROM event WHERE type = 'remote.seen'`
      assert.strictEqual(firstCount[0]?.n, 1)

      yield* db.remote.noteRemote({ id: REMOTE, name: "box-renamed" })
      yield* db.remote.noteRemote({ id: REMOTE, name: "box-renamed" })

      const secondCount = yield* sql<{ n: number }>`SELECT count(*) AS n FROM event WHERE type = 'remote.seen'`
      assert.strictEqual(secondCount[0]?.n, 2)

      const [remote] = yield* sql<{ name: string }>`SELECT name FROM remote WHERE id = ${REMOTE}`
      assert.strictEqual(remote?.name, "box-renamed")
    }).pipe(
      Effect.provide(
        Db.layer.pipe(
          Layer.provide(Projectors.layer),
          Layer.provide(Bus.layer),
          Layer.provide(SessionLive.layer),
          Layer.provideMerge(Platform.sqlite(":memory:")),
        ),
      ),
    ),
  )

  it.effect(
    "PublicCatalog filters all process.* and internal bookkeeping/transport facts from plugin event.subscribe",
    () =>
      Effect.gen(function* () {
        const bus = yield* Bus.Service
        const subscribe = PluginHost.factsFor(bus, "probe")

        assert.isFalse(Object.hasOwn(PublicCatalog, "process.started"))
        assert.isFalse(Object.hasOwn(PublicCatalog, "process.updated"))
        assert.isFalse(Object.hasOwn(PublicCatalog, "process.ready"))
        assert.isFalse(Object.hasOwn(PublicCatalog, "process.ended"))
        assert.isFalse(Object.hasOwn(PublicCatalog, "session.inbox.delivering"))
        assert.isFalse(Object.hasOwn(PublicCatalog, "machine.connected"))
        assert.isFalse(Object.hasOwn(PublicCatalog, "remote.seen"))
        assert.isFalse(Object.hasOwn(PublicCatalog, "remote.outbox.queued"))
        assert.isFalse(Object.hasOwn(PublicCatalog, "remote.outbox.acked"))

        const fiber = yield* subscribe().pipe(Stream.take(3), Stream.runCollect, Effect.forkScoped)

        const explicitFiber = yield* subscribe({
          types: [
            "remote.seen" as never,
            "process.started" as never,
            "process.updated" as never,
            "process.ready" as never,
            "process.ended" as never,
            "session.created",
          ],
        }).pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)

        yield* Effect.yieldNow

        yield* bus.transaction(
          Effect.gen(function* () {
            yield* bus.publish(Catalog["remote.seen"], { data: { id: REMOTE, name: "box" } })
            yield* bus.publish(Catalog["project.created"], {
              projectId: P,
              data: { directory: "/p", repositories: [] },
            })
            yield* bus.publish(Catalog["session.created"], {
              sessionId: S,
              data: { project: P, agent: "general", name: "sub", directory: "/p" },
            })

            const proc = yield* bus.publish(Catalog["process.started"], {
              sessionId: S,
              data: { harness: "pi", runtime: "herdr" },
            })

            yield* bus.publish(Catalog["process.updated"], { sessionId: S, data: { process: proc, pid: 42 } })
            yield* bus.publish(Catalog["process.ready"], { sessionId: S, data: { process: proc, pid: 42 } })
            yield* bus.publish(Catalog["process.ended"], { sessionId: S, data: { process: proc, reason: "archived" } })
            yield* bus.publish(Catalog["session.archived"], { sessionId: S, data: {} })
          }),
        )

        const received = yield* Fiber.join(fiber)
        assert.deepStrictEqual(
          received.map((f) => f.type),
          ["project.created", "session.created", "session.archived"],
        )

        const explicitReceived = yield* Fiber.join(explicitFiber)
        assert.deepStrictEqual(
          explicitReceived.map((f) => f.type),
          ["session.created"],
        )
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Db.layer.pipe(
            Layer.provide(Projectors.layer),
            Layer.provideMerge(Bus.layer),
            Layer.provide(SessionLive.layer),
            Layer.provideMerge(Platform.sqlite(":memory:")),
          ),
        ),
      ),
  )
})
