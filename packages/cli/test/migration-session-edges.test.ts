import { assert, describe, it } from "@effect/vitest"
import { Db } from "@vibest/core/database/db"
import { checkLedger, open } from "@vibest/core/database/migration"
import * as Projectors from "@vibest/core/database/projectors"
import { tempDirectory } from "@vibest/platform-bun/test/lib/fakes"
import { database } from "@vibest/platform-bun/test/lib/unit-helpers"
import { Effect, Layer, Path } from "effect"
import { SqlClient } from "effect/sql"

import * as Platform from "#platform"

const P1 = "11111111-1111-4111-8111-111111111111"
const P2 = "11111111-1111-4111-8111-111111111112"
const E = "22222222-2222-4222-8222-222222222222"
const A = "33333333-3333-4333-8333-333333333333"
const B = "44444444-4444-4444-8444-444444444444"
const C = "55555555-5555-4555-8555-555555555555"
const OTHER = "66666666-6666-4666-8666-666666666666"
const MIGRATION = "20261124000000_session_edges"

const oldFacts = [
  [P1, 1, "project.created", { directory: "/p1", repositories: [] }],
  [P2, 1, "project.created", { directory: "/p2", repositories: [] }],
  [E, 1, "session.created", { project: P1, agent: "coordinator", name: "entry", directory: "/p1" }],
  [
    A,
    1,
    "session.created",
    { project: P1, agent: "general", name: "a", directory: "/p1/a", parent: E, team: "t-1234" },
  ],
  [
    B,
    1,
    "session.created",
    { project: P1, agent: "general", name: "b", directory: "/p1/b", parent: E, team: "t-1234" },
  ],
  [C, 1, "session.created", { project: P1, agent: "general", name: "c", directory: "/p1/c", parent: E }],
  [OTHER, 1, "session.created", { project: P2, agent: "general", name: "o", directory: "/p2/o", team: "t-1234" }],
] as const

const runner = (file: string) => Projectors.replay.pipe(Layer.provideMerge(Platform.sqlite(file)))

describe("ledger migration 20261124000000_session_edges", () => {
  it.effect("strips team from session.created, backfills parent and team edges, and passes ledger replay", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path
      const file = path.join(yield* tempDirectory("vibest-session-edges-"), "vibest.db")
      yield* Effect.void.pipe(Effect.provide(database(file)))

      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`DELETE FROM migration WHERE id = ${MIGRATION}`
        yield* sql`UPDATE meta SET value = '11' WHERE key = 'catalog'`

        for (const [aggregate, seq, type, data] of oldFacts)
          yield* sql`INSERT INTO event (aggregate, seq, at, type, data)
            VALUES (${aggregate}, ${seq}, ${seq}, ${type}, ${JSON.stringify(data)})`
      }).pipe(Effect.provide(Platform.sqlite(file)))

      yield* open().pipe(Effect.provide(runner(file)))

      yield* Effect.gen(function* () {
        const stored = yield* Layer.build(Platform.sqlite(file)).pipe(
          Effect.flatMap((context) => SqlClient.SqlClient.pipe(Effect.provide(context))),
        )

        yield* checkLedger(stored).pipe(
          Effect.provide(Projectors.replay.pipe(Layer.provideMerge(Platform.sqlite(":memory:")))),
        )
      }).pipe(Effect.scoped)

      const { createdRows, edges } = yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient

        const createdRows = yield* sql<{ aggregate: string; data: string }>`
          SELECT aggregate, data FROM event WHERE type = 'session.created' ORDER BY position ASC
        `

        const edges = yield* sql<{ fromSessionId: string; toSessionId: string }>`
          SELECT from_session_id, to_session_id FROM session_edge ORDER BY from_session_id, to_session_id
        `

        return { createdRows, edges }
      }).pipe(Effect.provide(Platform.sqlite(file)))

      for (const row of createdRows) {
        const parsed = JSON.parse(row.data) as { team?: string }
        assert.isUndefined(parsed.team, `session.created for ${row.aggregate} still has team`)
      }

      assert.deepStrictEqual(
        edges.map((e) => [e.fromSessionId, e.toSessionId]),
        [
          [E, A],
          [E, B],
          [E, C],
          [A, E],
          [A, B],
          [B, E],
          [B, A],
          [C, E],
        ],
      )

      const maySend = yield* Effect.gen(function* () {
        const db = yield* Db.Service

        return {
          aToB: yield* db.inbox.maySend(A, B),
          bToA: yield* db.inbox.maySend(B, A),
          aToC: yield* db.inbox.maySend(A, C),
          aToOther: yield* db.inbox.maySend(A, OTHER),
          cToE: yield* db.inbox.maySend(C, E),
        }
      }).pipe(Effect.provide(database(file)))

      assert.deepStrictEqual(maySend, {
        aToB: true,
        bToA: true,
        aToC: false,
        aToOther: false,
        cToE: true,
      })
    }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )
})
