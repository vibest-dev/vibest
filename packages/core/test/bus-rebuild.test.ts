import { assert, describe, it } from "@effect/vitest"
import { Bus, equalToReplay } from "@vibest/core/bus"
import { inspectSchema } from "@vibest/core/database/db-schema"
import { open } from "@vibest/core/database/migration"
import * as Projectors from "@vibest/core/database/projectors"
import { ProjectEvent } from "@vibest/schema/project-event"
import { SessionEvent } from "@vibest/schema/session-event"
import { memorySqlite } from "@vibest/testkit/bun"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"

const P = "11111111-1111-4111-8111-111111111111"
const MAIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const SUB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

const memory = () => Layer.fresh(Projectors.replay.pipe(Layer.provideMerge(memorySqlite)))

const rowsOf = (sql: SqlClient.SqlClient, query: string) => sql.unsafe<Record<string, string | number | null>>(query)

const seed = Effect.gen(function* () {
  yield* open()
  const bus = yield* Bus.Service
  const sql = yield* SqlClient.SqlClient
  yield* bus.transaction(
    Effect.gen(function* () {
      yield* bus.publish(ProjectEvent.Created, { projectId: P, directory: "/w/app", repositories: [] }, { at: 100 })
      yield* bus.publish(
        SessionEvent.Created,
        { sessionId: MAIN, project: P, agent: "main", name: "main", directory: "/w/app" },
        { at: 110 },
      )
      yield* bus.publish(
        SessionEvent.Created,
        { sessionId: SUB, project: P, agent: "general", name: "sub", directory: "/w/app", parent: MAIN },
        { at: 120 },
      )
      yield* bus.publish(
        SessionEvent.InboxEnqueued,
        { sessionId: SUB, messageId: 1, sender: { type: "agent", session: MAIN }, content: "hi" },
        { at: 130 },
      )
    }),
  )

  return { bus, sql }
})

describe("rebuild and open", () => {
  it.effect("open on an already-migrated database is O(1) and preserves operational tables without replay", () =>
    Effect.gen(function* () {
      const { sql } = yield* seed
      yield* sql`UPDATE session SET name = 'kept-without-replay' WHERE id = ${SUB}`
      yield* open()
      assert.deepStrictEqual(yield* rowsOf(sql, `SELECT name FROM session WHERE id = '${SUB}'`), [
        { name: "kept-without-replay" },
      ])
    }).pipe(Effect.provide(memory())),
  )

  it.effect(
    "rebuild drops stray tables, preserves log indexes so inspectSchema stays ready, and replays identically",
    () =>
      Effect.gen(function* () {
        const { bus, sql } = yield* seed
        yield* sql`CREATE TABLE answer (execution INTEGER PRIMARY KEY)`
        yield* sql`DELETE FROM inbox`
        yield* bus.rebuild
        assert.deepStrictEqual(yield* rowsOf(sql, "SELECT name FROM sqlite_schema WHERE name = 'answer'"), [])
        assert.strictEqual(yield* inspectSchema(), "ready")
        assert.strictEqual(yield* equalToReplay(sql).pipe(Effect.provide(memory())), undefined)
        const [inbox] = yield* sql<{ n: number }>`SELECT count(*) AS n FROM inbox`
        assert.strictEqual(inbox!.n, 1)
      }).pipe(Effect.provide(memory())),
  )

  it.effect("a log row of a type outside the manifest fails the rebuild, names it and changes nothing", () =>
    Effect.gen(function* () {
      const { bus, sql } = yield* seed
      yield* sql`INSERT INTO event (id, aggregate_id, seq, created, type, data)
        VALUES ('evt_test_unknown', ${SUB}, 99, 1, 'session.purged.1', '{}')`
      const error = yield* bus.rebuild.pipe(Effect.flip)
      assert.strictEqual(error._tag, "InvalidDurableEvent")
      assert.include(error.message, `event ${SUB} 99`)
      const [sessions] = yield* sql<{ n: number }>`SELECT count(*) AS n FROM session`
      assert.strictEqual(sessions!.n, 2)
    }).pipe(Effect.provide(memory())),
  )
})
