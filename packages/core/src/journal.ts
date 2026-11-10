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
import { Clock, Context, Effect, Schema } from "effect"
import { SqlClient, type SqlError } from "effect/sql"

import { LOG_SCHEMA } from "./db-schema.ts"
import { project, PROJECTION_SCHEMA, PROJECTION_TABLES, PROJECTION_VERSION } from "./projectors.ts"

type Definition = (typeof Catalog)[FactType]

export interface Emit<D extends Definition> {
  readonly sessionId?: string
  readonly projectId?: string
  readonly at?: number
  readonly data: D["data"]["Type"]
}

const Buffer = Context.Reference<
  { readonly events: Array<unknown>; readonly fiberId: number; closed: boolean } | undefined
>("vibest/JournalBuffer", { defaultValue: () => undefined })

const setMeta = (sql: SqlClient.SqlClient, key: "catalog" | "projection", value: number) =>
  sql`INSERT INTO meta (key, value) VALUES (${key}, ${String(value)})
    ON CONFLICT (key) DO UPDATE SET value = excluded.value`

export const installLedger = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  for (const statement of [...LOG_SCHEMA, ...PROJECTION_SCHEMA]) yield* sql.unsafe(statement)
  yield* setMeta(sql, "catalog", CATALOG_VERSION)
  yield* setMeta(sql, "projection", PROJECTION_VERSION)
})

const REPLAY_PAGE = 1000

const readLog = (sql: SqlClient.SqlClient, after: number) =>
  sql<{ seq: number; at: number; type: string; project: string | null; session: string | null; data: string }>`SELECT
      seq, at, type, project_id AS project, session_id AS session, data
    FROM event WHERE seq > ${after} ORDER BY seq LIMIT ${REPLAY_PAGE}`.pipe(
    Effect.map((rows) =>
      rows.map((row): Row => ({
        seq: row.seq,
        at: row.at,
        type: row.type,
        project_id: row.project,
        session_id: row.session,
        data: row.data,
      })),
    ),
  )

const replayFrom = (sql: SqlClient.SqlClient, after: number): Effect.Effect<void, SqlError.SqlError | UnknownFact> =>
  readLog(sql, after).pipe(
    Effect.flatMap((rows) =>
      Effect.gen(function* () {
        for (const row of rows) yield* project(yield* decodeRow(row), sql)
        if (rows.length === REPLAY_PAGE) yield* replayFrom(sql, rows[rows.length - 1]!.seq)
      }),
    ),
  )

const dropProjection = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const objects = yield* sql<{ type: string; name: string }>`SELECT type, name FROM sqlite_schema
      WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%' AND name NOT IN ('event', 'meta')
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
          yield* to`INSERT INTO event (seq, at, type, project_id, session_id, data)
            VALUES (${row.seq}, ${row.at}, ${row.type}, ${row.project_id}, ${row.session_id}, ${row.data})`
        if (rows.length === REPLAY_PAGE) yield* copyLog(from, to, rows[rows.length - 1]!.seq)
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

type Envelope = {
  readonly seq?: number
  readonly at: number
  readonly type: FactType
  readonly projectId?: string | undefined
  readonly sessionId?: string | undefined
}

const write = (sql: SqlClient.SqlClient, envelope: Envelope, data: string) =>
  Effect.gen(function* () {
    const [row] = yield* sql<{ seq: number }>`INSERT INTO event (seq, at, type, project_id, session_id, data)
      VALUES (${envelope.seq ?? null}, ${envelope.at}, ${envelope.type}, ${envelope.projectId ?? null},
        ${envelope.sessionId ?? null}, ${data}) RETURNING seq`
    const fact = yield* decodeRow({
      seq: row!.seq,
      at: envelope.at,
      type: envelope.type,
      project_id: envelope.projectId ?? null,
      session_id: envelope.sessionId ?? null,
      data,
    })
    yield* project(fact, sql)
    return fact
  })

export const append = (fact: Fact) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const data = yield* encodeData(Catalog[fact.type], fact.data as never).pipe(
      Effect.mapError(
        (cause) =>
          new UnknownFact({
            seq: fact.seq,
            type: fact.type,
            message: `event ${fact.seq}: ${fact.type} does not encode: ${cause.message}`,
          }),
      ),
    )
    return yield* write(sql, fact, data)
  })

export const makeJournal = <Signal = never>(published: (events: ReadonlyArray<Fact | Signal>) => Effect.Effect<void>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    const commit = <A, E, R>(body: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        if ((yield* Buffer) !== undefined) return yield* body
        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const buffer = { events: [] as Array<Fact | Signal>, fiberId: yield* Effect.fiberId, closed: false }
            const result = yield* sql
              .withTransaction(restore(Effect.provideService(body, Buffer, buffer)))
              .pipe(Effect.ensuring(Effect.sync(() => (buffer.closed = true))))
            if (buffer.events.length > 0) yield* published(buffer.events)
            return result
          }),
        )
      })

    const projectOf = (definition: Definition, input: Emit<Definition>) =>
      Effect.gen(function* () {
        const takesProject = definition.envelope === "project" || definition.type === "session.created"
        if (!takesProject && input.projectId !== undefined)
          return yield* Effect.die(
            new Error(`${definition.type} takes its project from its session, not from the caller`),
          )
        if (definition.envelope === "none") return undefined
        if (takesProject) {
          if (input.projectId === undefined) return yield* Effect.die(new Error(`${definition.type} needs a project`))
          return input.projectId
        }
        const [row] = yield* sql<{ project: string }>`SELECT project_id AS project FROM session
          WHERE id = ${input.sessionId!}`
        if (row === undefined) return yield* Effect.die(new Error(`${definition.type}: no session ${input.sessionId}`))
        return row.project
      })

    const emit = <D extends Definition>(definition: D, input: Emit<D>) =>
      Effect.gen(function* () {
        const buffer = yield* Buffer
        if (buffer === undefined) return yield* Effect.die(new Error("emit outside a transaction"))
        if (buffer.closed || (yield* Effect.fiberId) !== buffer.fiberId)
          return yield* Effect.die(new Error("emit not from the transaction fiber"))
        if ((definition.envelope === "session") !== (input.sessionId !== undefined))
          return yield* Effect.die(new Error(`${definition.type} takes a session only with a session envelope`))
        const projectId = yield* projectOf(definition, input)
        const at = input.at ?? (yield* Clock.currentTimeMillis)
        const data = yield* encodeData(definition, input.data as never).pipe(Effect.orDie)
        const fact = yield* write(sql, { at, type: definition.type, projectId, sessionId: input.sessionId }, data).pipe(
          Effect.orDie,
        )
        buffer.events.push(fact)
        return fact.seq
      })

    const notify = (signal: Signal) =>
      Effect.gen(function* () {
        const buffer = yield* Buffer
        if (buffer !== undefined && !buffer.closed) buffer.events.push(signal)
        else yield* published([signal])
      })

    return { commit, emit, notify, rebuild }
  })
