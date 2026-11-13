import {
  Catalog,
  CATALOG_VERSION,
  decodeRow,
  encodeData,
  type Fact,
  type FactType,
  type Row,
  UnknownFact,
} from "@vibest/schema/event"
import { randomId } from "@vibest/schema/id"
import { Clock, Context, Effect, Schema } from "effect"
import { SqlClient, type SqlError } from "effect/sql"

import { LOG_SCHEMA, ledgerOf, MIGRATION_TABLE } from "./db-schema.ts"
import { project, PROJECTION_SCHEMA, PROJECTION_TABLES, PROJECTION_VERSION } from "./projectors.ts"

type Definition = (typeof Catalog)[FactType]

export interface Emit<D extends Definition> {
  readonly sessionId?: string
  readonly projectId?: string
  readonly at?: number
  readonly data: D["data"]["Type"]
}

const Buffer = Context.Reference<
  | {
      readonly events: Array<unknown>
      readonly after: Array<Effect.Effect<void>>
      readonly fiberId: number
      closed: boolean
    }
  | undefined
>("vibest/JournalBuffer", { defaultValue: () => undefined })

const setMeta = (sql: SqlClient.SqlClient, key: "catalog" | "projection", value: number) =>
  sql`INSERT INTO meta (key, value) VALUES (${key}, ${String(value)})
    ON CONFLICT (key) DO UPDATE SET value = excluded.value`

export const installLedger = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  for (const statement of [...LOG_SCHEMA, ...PROJECTION_SCHEMA]) yield* sql.unsafe(statement)
  yield* setMeta(sql, "catalog", CATALOG_VERSION)
  yield* setMeta(sql, "projection", PROJECTION_VERSION)
  yield* sql`INSERT INTO meta (key, value) VALUES ('ledger', ${randomId()})`
})

const REPLAY_PAGE = 1000

type Logged = Row & { readonly position: number }

const readLog = (sql: SqlClient.SqlClient, after: number) =>
  sql<Logged>`SELECT position, aggregate, seq, at, type, data
    FROM event WHERE position > ${after} ORDER BY position LIMIT ${REPLAY_PAGE}`

const replayFrom = (sql: SqlClient.SqlClient, after: number): Effect.Effect<void, SqlError.SqlError | UnknownFact> =>
  readLog(sql, after).pipe(
    Effect.flatMap((rows) =>
      Effect.gen(function* () {
        for (const row of rows) yield* project(yield* decodeRow(row), sql)
        if (rows.length === REPLAY_PAGE) yield* replayFrom(sql, rows[rows.length - 1]!.position)
      }),
    ),
  )

const dropProjection = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const objects = yield* sql<{ type: string; name: string }>`SELECT type, name FROM sqlite_schema
      WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%' AND name NOT IN ('event', 'meta', ${MIGRATION_TABLE})
      ORDER BY type = 'index'`
    for (const object of objects)
      yield* sql.unsafe(`DROP ${object.type === "table" ? "TABLE" : "INDEX"} IF EXISTS "${object.name}"`)
  })

export const rebuild = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* dropProjection(sql)
      for (const statement of PROJECTION_SCHEMA) yield* sql.unsafe(statement)
      yield* replayFrom(sql, 0)
      yield* setMeta(sql, "projection", PROJECTION_VERSION)
    }),
  )
})

const dump = (sql: SqlClient.SqlClient, table: keyof typeof PROJECTION_TABLES) =>
  sql.unsafe<Record<string, unknown>>(`SELECT * FROM ${table} ORDER BY ${PROJECTION_TABLES[table]}`)

const copyLog = (
  from: SqlClient.SqlClient,
  to: SqlClient.SqlClient,
  after: number,
): Effect.Effect<void, SqlError.SqlError> =>
  readLog(from, after).pipe(
    Effect.flatMap((rows) =>
      Effect.gen(function* () {
        for (const row of rows)
          yield* to`INSERT INTO event (position, aggregate, seq, at, type, data)
            VALUES (${row.position}, ${row.aggregate}, ${row.seq}, ${row.at}, ${row.type}, ${row.data})`
        if (rows.length === REPLAY_PAGE) yield* copyLog(from, to, rows[rows.length - 1]!.position)
      }),
    ),
  )

const firstDifference = (
  table: string,
  key: string,
  stored: ReadonlyArray<Record<string, unknown>>,
  replayed: ReadonlyArray<Record<string, unknown>>,
) => {
  for (let i = 0; i < Math.max(stored.length, replayed.length); i++) {
    const a = stored[i] === undefined ? undefined : JSON.stringify(stored[i])
    const b = replayed[i] === undefined ? undefined : JSON.stringify(replayed[i])
    if (a !== b) return `${table} row ${i + 1} (by ${key}): stored ${a ?? "nothing"}, replayed ${b ?? "nothing"}`
  }
  return undefined
}

const copyWholeLog = (stored: SqlClient.SqlClient, scratch: SqlClient.SqlClient) =>
  scratch.withTransaction(
    Effect.gen(function* () {
      for (const statement of LOG_SCHEMA) yield* scratch.unsafe(statement)
      yield* copyLog(stored, scratch, 0)
    }),
  )

export const equalToReplay = (stored: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const scratch = yield* SqlClient.SqlClient
    const tables = Object.keys(PROJECTION_TABLES) as Array<keyof typeof PROJECTION_TABLES>
    const storedTables = yield* stored.withTransaction(
      Effect.gen(function* () {
        yield* copyWholeLog(stored, scratch)
        return yield* Effect.forEach(tables, (table) => dump(stored, table))
      }),
    )
    yield* rebuild
    for (const [i, table] of tables.entries()) {
      const difference = firstDifference(table, PROJECTION_TABLES[table], storedTables[i]!, yield* dump(scratch, table))
      if (difference !== undefined) return difference
    }
    return undefined
  })

export class ReplayDiffers extends Schema.TaggedError<ReplayDiffers>()("ReplayDiffers", {
  message: Schema.String,
}) {}

export const checkReplay = (stored: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const [projection] = yield* stored<{ value: string }>`SELECT value FROM meta WHERE key = 'projection'`
    if (Number(projection?.value) !== PROJECTION_VERSION) {
      yield* copyWholeLog(stored, yield* SqlClient.SqlClient)
      return yield* rebuild
    }
    const difference = yield* equalToReplay(stored)
    if (difference !== undefined)
      return yield* new ReplayDiffers({ message: `the read model differs from a replay of its log: ${difference}` })
  })

const write = (sql: SqlClient.SqlClient, aggregate: string, at: number, type: FactType, data: string) =>
  Effect.gen(function* () {
    const [row] = yield* sql<{ seq: number }>`INSERT INTO event (aggregate, seq, at, type, data)
      VALUES (${aggregate}, (SELECT coalesce(max(seq), 0) + 1 FROM event WHERE aggregate = ${aggregate}), ${at},
        ${type}, ${data}) RETURNING seq`
    const fact = yield* decodeRow({ aggregate, seq: row!.seq, at, type, data })
    yield* project(fact, sql)
    return fact
  })

export const makeJournal = <Signal = never>(published: (events: ReadonlyArray<Fact | Signal>) => Effect.Effect<void>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    const commit = <A, E, R>(body: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        if ((yield* Buffer) !== undefined) return yield* body
        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const buffer = {
              events: [] as Array<Fact | Signal>,
              after: [] as Array<Effect.Effect<void>>,
              fiberId: yield* Effect.fiberId,
              closed: false,
            }
            const result = yield* sql
              .withTransaction(restore(Effect.provideService(body, Buffer, buffer)))
              .pipe(Effect.ensuring(Effect.sync(() => (buffer.closed = true))))
            yield* Effect.all(buffer.after, { discard: true })
            if (buffer.events.length > 0) yield* published(buffer.events)
            return result
          }),
        )
      })

    let ledger: string | undefined
    const ledgerId = Effect.gen(function* () {
      ledger ??= yield* ledgerOf(sql)
      if (ledger === undefined) return yield* Effect.die(new Error("the database has no ledger id"))
      return ledger
    })

    const aggregateOf = (definition: Definition, input: Emit<Definition>) =>
      Effect.gen(function* () {
        const { sessionId, projectId } = input
        if (definition.aggregate === "session" && sessionId !== undefined && projectId === undefined) return sessionId
        if (definition.aggregate === "project" && projectId !== undefined && sessionId === undefined) return projectId
        if (definition.aggregate === "ledger" && sessionId === undefined && projectId === undefined)
          return yield* ledgerId
        return yield* Effect.die(new Error(`${definition.type} belongs to a ${definition.aggregate} aggregate`))
      })

    const emit = <D extends Definition>(definition: D, input: Emit<D>) =>
      Effect.gen(function* () {
        const buffer = yield* Buffer
        if (buffer === undefined) return yield* Effect.die(new Error("emit outside a transaction"))
        if (buffer.closed || (yield* Effect.fiberId) !== buffer.fiberId)
          return yield* Effect.die(new Error("emit not from the transaction fiber"))
        const aggregate = yield* aggregateOf(definition, input)
        const at = input.at ?? (yield* Clock.currentTimeMillis)
        const data = yield* encodeData(definition, input.data as never).pipe(Effect.orDie)
        const fact = yield* write(sql, aggregate, at, definition.type, data).pipe(Effect.orDie)
        buffer.events.push(fact)
        return fact.seq
      })

    const notify = (signal: Signal) =>
      Effect.gen(function* () {
        const buffer = yield* Buffer
        if (buffer !== undefined && !buffer.closed) buffer.events.push(signal)
        else yield* published([signal])
      })

    const afterCommit = (effect: Effect.Effect<void>) =>
      Effect.gen(function* () {
        const buffer = yield* Buffer
        if (buffer !== undefined && !buffer.closed) buffer.after.push(effect)
        else yield* effect
      })

    return { commit, emit, notify, afterCommit, rebuild }
  })
