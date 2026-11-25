import { assert, describe, it } from "@effect/vitest"
import { Db } from "@vibest/core/database/db"
import { checkLedger, open } from "@vibest/core/database/migration"
import * as Projectors from "@vibest/core/database/projectors"
import { tempDirectory } from "@vibest/platform-bun/test/lib/fakes"
import { database } from "@vibest/platform-bun/test/lib/unit-helpers"
import { Effect, Layer, Path } from "effect"
import { SqlClient } from "effect/sql"

import * as Platform from "#platform"

const P = "11111111-1111-4111-8111-111111111111"
const REMOTE_PROJECT = "11111111-1111-4111-8111-111111111112"
const REMOTE_ID = "22222222-2222-4222-8222-222222222222"
const MACHINE_ID = "33333333-3333-4333-8333-333333333333"
const ORIGIN_SESSION = "44444444-4444-4444-8444-444444444444"
const CHILD = "55555555-5555-4555-8555-555555555555"
const ITEM_1 = "66666666-6666-4666-8666-666666666661"
const ITEM_2 = "66666666-6666-4666-8666-666666666662"
const MIGRATION = "20261124020000_remote_and_cross_machine_edges"

const runner = (file: string) => Projectors.replay.pipe(Layer.provideMerge(Platform.sqlite(file)))

describe("ledger migration 20261124020000_remote_and_cross_machine_edges", () => {
  it.effect("rewrites legacy peer facts, backfills cross-machine session.linked, and passes ledger replay", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path
      const file = path.join(yield* tempDirectory("vibest-remote-edges-"), "vibest.db")
      yield* Effect.void.pipe(Effect.provide(database(file)))

      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const [ledgerRow] = yield* sql<{ value: string }>`SELECT value FROM meta WHERE key = 'ledger'`
        const ledger = ledgerRow!.value

        yield* sql`DELETE FROM migration WHERE id >= ${MIGRATION}`
        yield* sql`UPDATE meta SET value = '12' WHERE key = 'catalog'`

        const legacyFacts = [
          [P, 1, 10, "project.created", { directory: "/p", repositories: [] }],
          [ledger, 1, 20, "machine.added", { name: "mb", target: "b-host", vibestd: MACHINE_ID }],
          [ledger, 2, 30, "peer.seen", { id: REMOTE_ID, name: "mac-a" }],
          [
            CHILD,
            1,
            40,
            "session.created",
            {
              project: P,
              agent: "general",
              name: "remote-child",
              directory: "/p/child",
              origin: { peer: REMOTE_ID, project: REMOTE_PROJECT, session: ORIGIN_SESSION },
            },
          ],
          [ledger, 3, 50, "outbox.queued", { id: ITEM_1, peer: REMOTE_ID, session: CHILD, content: "done" }],
          [
            ledger,
            4,
            51,
            "outbox.queued",
            { id: ITEM_2, peer: REMOTE_ID, session: CHILD, kind: "send", content: "hi" },
          ],
          [ledger, 5, 60, "outbox.acked", { peer: REMOTE_ID, ids: [ITEM_1] }],
        ] as const

        for (const [aggregate, seq, at, type, data] of legacyFacts)
          yield* sql`INSERT INTO event (aggregate, seq, at, type, data)
            VALUES (${aggregate}, ${seq}, ${at}, ${type}, ${JSON.stringify(data)})`
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

      const projected = yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient

        const machines = yield* sql<{ name: string; remoteId: string }>`SELECT name, remote_id FROM machine`
        const remotes = yield* sql<{ id: string; name: string }>`SELECT id, name FROM remote`
        const sessions = yield* sql<{ id: string; originRemote: string | null }>`SELECT id, origin_remote FROM session`

        const edges = yield* sql<{
          fromSessionId: string
          toRemoteId: string
          toSessionId: string
        }>`SELECT from_session_id, to_remote_id, to_session_id FROM session_edge`

        const outbox = yield* sql<{
          id: string
          remoteId: string
        }>`SELECT id, remote_id FROM outbox WHERE acked_at IS NULL`

        return { machines, remotes, sessions, edges, outbox }
      }).pipe(Effect.provide(Platform.sqlite(file)))

      assert.deepStrictEqual(projected.machines, [{ name: "mb", remoteId: MACHINE_ID }])
      assert.deepStrictEqual(projected.remotes, [{ id: REMOTE_ID, name: "mac-a" }])
      assert.deepStrictEqual(projected.sessions, [{ id: CHILD, originRemote: REMOTE_ID }])
      assert.deepStrictEqual(projected.edges, [
        { fromSessionId: CHILD, toRemoteId: REMOTE_ID, toSessionId: ORIGIN_SESSION },
      ])
      assert.deepStrictEqual(projected.outbox, [{ id: ITEM_2, remoteId: REMOTE_ID }])

      const allowed = yield* Effect.flatMap(Db.Service, (db) =>
        db.inbox.maySend(CHILD, ORIGIN_SESSION, REMOTE_ID),
      ).pipe(Effect.provide(database(file)))

      assert.isTrue(allowed)
    }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )
})
