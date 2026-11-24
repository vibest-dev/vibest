import { assert, describe, it } from "@effect/vitest"
import { checkLedger, open } from "@vibest/core/database/migration"
import * as Projectors from "@vibest/core/database/projectors"
import { tempDirectory } from "@vibest/platform-bun/test/lib/fakes"
import { database } from "@vibest/platform-bun/test/lib/unit-helpers"
import { Effect, Layer, Path } from "effect"
import { SqlClient } from "effect/sql"

import * as Platform from "#platform"

const P1 = "11111111-1111-4111-8111-111111111111"
const S1 = "22222222-2222-4222-8222-222222222222"
const S2 = "33333333-3333-4333-8333-333333333333"
const MIGRATION = "20261124010000_drop_project_entry"

const oldFacts = [
  [P1, 1, "project.created", { directory: "/p1", repositories: [] }],
  [S1, 1, "session.created", { project: P1, agent: "coordinator", name: "entry-1", directory: "/p1" }],
  [P1, 2, "project.entry_changed", { session: S1 }],
  [S1, 2, "session.ended", { reason: "replaced" }],
  [S2, 1, "session.created", { project: P1, agent: "coordinator", name: "entry-2", directory: "/p1" }],
  [P1, 3, "project.entry_changed", { session: S2 }],
  [P1, 4, "project.moved", { from: "/p1", to: "/p1-moved", repositories: [] }],
] as const

const runner = (file: string) => Projectors.replay.pipe(Layer.provideMerge(Platform.sqlite(file)))

describe("ledger migration 20261124010000_drop_project_entry", () => {
  it.effect(
    "rewrites replaced to archived, drops project.entry_changed, renumbers seq densely, and passes replay",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path
        const file = path.join(yield* tempDirectory("vibest-drop-entry-"), "vibest.db")
        yield* Effect.void.pipe(Effect.provide(database(file)))

        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* sql`DELETE FROM migration WHERE id = ${MIGRATION}`
          yield* sql`UPDATE meta SET value = '12' WHERE key = 'catalog'`

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

        const { projectEvents, endedRows } = yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient

          const projectEvents = yield* sql<{ seq: number; type: string }>`
          SELECT seq, type FROM event WHERE aggregate = ${P1} ORDER BY seq ASC
        `

          const endedRows = yield* sql<{ aggregate: string; data: string }>`
          SELECT aggregate, data FROM event WHERE type = 'session.ended'
        `

          return { projectEvents, endedRows }
        }).pipe(Effect.provide(Platform.sqlite(file)))

        assert.deepStrictEqual(projectEvents, [
          { seq: 1, type: "project.created" },
          { seq: 2, type: "project.moved" },
        ])

        assert.deepStrictEqual(endedRows, [{ aggregate: S1, data: JSON.stringify({ reason: "archived" }) }])
      }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )
})
