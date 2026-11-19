import { assert, describe, it } from "@effect/vitest"
import { checkLedger, open } from "@vibest/core/database/migration"
import * as Projectors from "@vibest/core/database/projectors"
import { tempDirectory } from "@vibest/platform-bun/test/lib/fakes"
import { database } from "@vibest/platform-bun/test/lib/unit-helpers"
import { CATALOG_VERSION } from "@vibest/schema/event"
import { Effect, Exit, FileSystem, Layer, Path } from "effect"
import { SqlClient } from "effect/sql"

import * as Platform from "#platform"

const P = "11111111-1111-4111-8111-111111111111"
const E = "22222222-2222-4222-8222-222222222222"
const S = "33333333-3333-4333-8333-333333333333"
const R = "44444444-4444-4444-8444-444444444444"
const PEER = "55555555-5555-4555-8555-555555555555"
const MIGRATION = "20261119000000_one_sender"

type Fact = readonly [aggregate: string, seq: number, type: string, data: object]

const catalog2 = (ledger: string): ReadonlyArray<Fact> => [
  [P, 1, "project.created", { directory: "/p", repositories: [] }],
  [E, 1, "session.created", { project: P, agent: "coordinator", name: "entry", directory: "/p" }],
  [S, 1, "session.created", { project: P, agent: "general", name: "sub", directory: "/p/s", parent: E }],
  [ledger, 1, "machine.added", { name: "box", target: "box", vibestd: PEER }],
  [
    R,
    1,
    "session.created",
    {
      project: P,
      agent: "general",
      name: "r",
      directory: "/p/r",
      origin: { peer: PEER, project: "rp", session: "far" },
    },
  ],
  [S, 2, "inbox.queued", { kind: "task", sender: E, content: "do it", status: "delivered" }],
  [S, 3, "execution.started", {}],
  [
    E,
    2,
    "inbox.queued",
    {
      kind: "send",
      sender: S,
      from: { session: S, agent: "general", title: "sub" },
      content: "done",
      status: "pending",
    },
  ],
  [
    ledger,
    2,
    "outbox.queued",
    {
      id: "66666666-6666-4666-8666-666666666661",
      peer: PEER,
      session: S,
      recipient: "far",
      kind: "send",
      content: "hi",
      from: { session: S },
    },
  ],
  [
    ledger,
    3,
    "outbox.queued",
    { id: "66666666-6666-4666-8666-666666666662", peer: PEER, session: S, recipient: "far", content: "S ended" },
  ],
  [S, 4, "execution.ended", { execution: 3, outcome: "completed" }],
  [E, 3, "inbox.queued", { kind: "notice", sender: S, content: "sub archived", status: "pending" }],
  [E, 4, "inbox.queued", { kind: "send", sender: S, content: "later", status: "pending" }],
  [S, 5, "inbox.queued", { kind: "send", content: "typed by the user", status: "pending" }],
  [R, 2, "inbox.queued", { kind: "task", content: "remote task", status: "pending" }],
]

const rewritten = {
  [`${S} 2`]: { kind: "task", content: "do it", status: "delivered", sender: { session: E } },
  [`${E} 2`]: {
    kind: "send",
    content: "done",
    status: "pending",
    sender: { session: S, agent: "general", title: "sub" },
    execution: 3,
  },
  [`${E} 3`]: { kind: "notice", content: "sub archived", status: "pending", sender: "vibest", about: S },
  [`${E} 4`]: { kind: "send", content: "later", status: "pending", sender: { session: S } },
  [`${S} 5`]: { kind: "send", content: "typed by the user", status: "pending", sender: "user" },
  [`${R} 2`]: { kind: "task", content: "remote task", status: "pending", sender: { session: "far", machine: "box" } },
}

const runner = (file: string) => Projectors.replay.pipe(Layer.provideMerge(Platform.sqlite(file)))

const oldLedger = Effect.gen(function* () {
  const path = yield* Path.Path
  const file = path.join(yield* tempDirectory("vibest-one-sender-"), "vibest.db")
  yield* Effect.void.pipe(Effect.provide(database(file)))

  yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [ledger] = yield* sql<{ value: string }>`SELECT value FROM meta WHERE key = 'ledger'`
    yield* sql`DELETE FROM migration WHERE id = ${MIGRATION}`
    yield* sql`UPDATE meta SET value = '2' WHERE key = 'catalog'`

    for (const [aggregate, seq, type, data] of catalog2(ledger!.value))
      yield* sql`INSERT INTO event (aggregate, seq, at, type, data)
        VALUES (${aggregate}, ${seq}, ${seq}, ${type}, ${JSON.stringify(data)})`
  }).pipe(Effect.provide(Platform.sqlite(file)))

  return file
})

const read = <A extends object>(
  file: string,
  query: (sql: SqlClient.SqlClient) => Effect.Effect<ReadonlyArray<A>, unknown>,
) => Effect.flatMap(SqlClient.SqlClient, query).pipe(Effect.provide(Platform.sqlite(file)))

describe("ledger migration 20261119000000_one_sender", () => {
  it.effect(
    "rewrites catalog-2 inbox facts to one tagged sender, gives sends their sender's execution by position, and import-check passes on the old file first",
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
        assert.deepStrictEqual(yield* fs.readFile(file), before, "import-check migrates only its copy")

        yield* open().pipe(Effect.provide(runner(file)))

        const inbox = yield* read<{ aggregate: string; seq: number; data: string }>(
          file,
          (sql) => sql`SELECT aggregate, seq, data FROM event WHERE type = 'inbox.queued'`,
        )

        assert.deepStrictEqual(
          Object.fromEntries(inbox.map((row) => [`${row.aggregate} ${row.seq}`, JSON.parse(row.data)])),
          rewritten,
        )

        const outbox = yield* read<{ data: string }>(
          file,
          (sql) => sql`SELECT data FROM event WHERE type = 'outbox.queued' ORDER BY position`,
        )

        assert.deepStrictEqual(
          outbox.map((row) => JSON.parse(row.data).execution),
          [3, undefined],
        )

        assert.deepStrictEqual(yield* read(file, (sql) => sql`SELECT session_id, id, sent FROM execution`), [
          { sessionId: S, id: 3, sent: 2 },
        ])
        assert.deepStrictEqual(
          yield* read(
            file,
            (sql) =>
              sql`SELECT (SELECT value FROM meta WHERE key = 'catalog') AS catalog,
                (SELECT count(*) FROM migration WHERE id = ${MIGRATION}) AS applied`,
          ),
          [{ catalog: String(CATALOG_VERSION), applied: 1 }],
        )
      }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )
})
