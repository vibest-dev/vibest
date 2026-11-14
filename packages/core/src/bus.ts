import type { Runtime } from "@vibest/plugin/effect"
import {
  Catalog,
  decodeRow,
  encodeData,
  type Fact,
  type FactOf,
  type FactType,
  type Row,
  UnknownFact,
} from "@vibest/schema/event"
import type { RuntimeAddress } from "@vibest/schema/session"
import { Clock, Context, type Duration, Effect, Layer, Option, PubSub, Queue, Schema, type Scope, Stream } from "effect"
import { SqlClient, type SqlError } from "effect/sql"

import {
  ledgerOf,
  LOG_SCHEMA,
  MIGRATION_TABLE,
  PROJECTION_SCHEMA,
  PROJECTION_TABLES,
  PROJECTION_VERSION,
  setMeta,
} from "./database/db-schema.ts"
import { LayerNode } from "./effect/layer-node.ts"
import { PlatformNode } from "./effect/platform.ts"

export type Signal =
  | {
      readonly type: "terminal.state"
      readonly runtime: string
      readonly terminal: RuntimeAddress
      readonly state: Runtime.AgentState
    }
  | { readonly type: "terminal.exited"; readonly runtime: string; readonly terminal: RuntimeAddress }
  | { readonly type: "terminal.seen"; readonly runtime: string; readonly terminal: RuntimeAddress }
  | { readonly type: "runtime.reset"; readonly runtime: string; readonly machine: string }
  | { readonly type: "drain.released" }
  | { readonly type: "session.changed"; readonly sessionId: string }
  | { readonly type: "project.changed"; readonly projectId: string }

export type BusEvent = Fact | Signal

export const TerminalState = { type: "terminal.state" } as const
export const TerminalExited = { type: "terminal.exited" } as const
export const RuntimeReset = { type: "runtime.reset" } as const

type EventOf<T extends BusEvent["type"]> = Extract<BusEvent, { readonly type: T }>

export interface Subscribe {
  (): Effect.Effect<PubSub.Subscription<BusEvent>, never, Scope.Scope>
  <T extends BusEvent["type"]>(
    definitions: ReadonlyArray<{ readonly type: T }>,
  ): Effect.Effect<PubSub.Subscription<EventOf<T>>, never, Scope.Scope>
}

export type Definition = (typeof Catalog)[FactType]

export type Projector<D extends Definition> = (fact: FactOf<D["type"]>) => Effect.Effect<unknown, SqlError.SqlError>

export interface PublishInput<D extends Definition> {
  readonly sessionId?: string
  readonly projectId?: string
  readonly at?: number
  readonly data: D["data"]["Type"]
}

const Buffer = Context.Reference<
  | {
      readonly events: Array<BusEvent>
      readonly after: Array<() => void>
      readonly fiberId: number
      closed: boolean
    }
  | undefined
>("vibest/BusBuffer", { defaultValue: () => undefined })

const REPLAY_PAGE = 1000

type Logged = Row & { readonly position: number }

const readLog = (sql: SqlClient.SqlClient, after: number) =>
  sql<Logged>`SELECT position, aggregate, seq, at, type, data
    FROM event WHERE position > ${after} ORDER BY position LIMIT ${REPLAY_PAGE}`

type Cursor = { readonly aggregate: string; readonly after: number } | { readonly log: number }

const readPage = (sql: SqlClient.SqlClient, cursor: Cursor, until: number | undefined) =>
  "aggregate" in cursor
    ? sql<Row>`SELECT aggregate, seq, at, type, data
        FROM event WHERE aggregate = ${cursor.aggregate} AND seq > ${cursor.after} AND seq <= ${until ?? Number.MAX_SAFE_INTEGER}
        ORDER BY seq LIMIT ${REPLAY_PAGE}`
    : sql<Logged>`SELECT position, aggregate, seq, at, type, data
        FROM event WHERE position > ${cursor.log} AND position <= ${until ?? Number.MAX_SAFE_INTEGER}
        ORDER BY position LIMIT ${REPLAY_PAGE}`

const watermark = (sql: SqlClient.SqlClient, cursor: Cursor) =>
  (
    ("aggregate" in cursor
      ? sql<{ latest: number }>`SELECT coalesce(max(seq), 0) AS latest FROM event WHERE aggregate = ${cursor.aggregate}`
      : sql<{ latest: number }>`SELECT coalesce(max(position), 0) AS latest FROM event`) as Effect.Effect<
      ReadonlyArray<{ latest: number }>,
      SqlError.SqlError
    >
  ).pipe(Effect.map((rows) => rows[0]!.latest))

const publicRow = (row: Row): Row => ({
  aggregate: row.aggregate,
  seq: row.seq,
  at: row.at,
  type: row.type,
  data: row.data,
})

const advance = (cursor: Cursor, page: ReadonlyArray<Row>): Cursor => {
  const last = page[page.length - 1]! as Logged
  return "aggregate" in cursor ? { aggregate: cursor.aggregate, after: last.seq } : { log: last.position }
}

const followFacts = (
  sql: SqlClient.SqlClient,
  wake: Effect.Effect<void>,
  start: Cursor,
  follow: boolean,
): Stream.Stream<Row, SqlError.SqlError> =>
  Stream.unwrap(
    Effect.map(follow ? Effect.undefined : watermark(sql, start), (until) =>
      Stream.unfold(start, (cursor) =>
        readPage(sql, cursor, until).pipe(
          Effect.flatMap((page) =>
            page.length > 0
              ? Effect.succeed([page.map(publicRow) as ReadonlyArray<Row>, advance(cursor, page)] as const)
              : follow
                ? wake.pipe(Effect.andThen(Effect.succeed([[] as ReadonlyArray<Row>, cursor] as const)))
                : Effect.undefined,
          ),
        ),
      ).pipe(Stream.flattenIterable),
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

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const pubsub = yield* PubSub.unbounded<BusEvent>()
  const typed = new Map<string, Set<PubSub.PubSub<BusEvent>>>()
  const projectors = new Map<string, (fact: never) => ReturnType<Projector<Definition>>>()

  const project = <D extends Definition>(definition: D, projector: Projector<D>) =>
    Effect.sync(() => void projectors.set(definition.type, projector))

  const projectFact = (fact: Fact) => {
    const projector = projectors.get(fact.type)
    return projector === undefined
      ? Effect.fail(
          new UnknownFact({
            aggregate: fact.aggregate,
            seq: fact.seq,
            type: fact.type,
            message: `event ${fact.aggregate} ${fact.seq}: ${fact.type} has no projector`,
          }),
        )
      : projector(fact as never)
  }

  const deliverTyped = (event: BusEvent) =>
    Effect.forEach(typed.get(event.type) ?? [], (subscriber) => PubSub.publish(subscriber, event), { discard: true })

  const batches: Array<ReadonlyArray<BusEvent>> = []
  let delivering = false

  const drain = Effect.gen(function* () {
    for (let batch = batches.shift(); batch !== undefined; batch = batches.shift()) {
      yield* PubSub.publishAll(pubsub, batch)
      yield* Effect.forEach(batch, deliverTyped, { discard: true })
    }
  }).pipe(Effect.ensuring(Effect.sync(() => void (delivering = false))))

  const deliver = (events: ReadonlyArray<BusEvent>) =>
    Effect.suspend(() => {
      const all = withChanges(events)
      if (all.length === 0) return Effect.void
      batches.push(all)
      if (delivering) return Effect.void
      delivering = true
      return Effect.uninterruptible(drain)
    })

  const subscribeTyped = (definitions: ReadonlyArray<{ readonly type: string }>) => {
    const types = new Set(definitions.map((definition) => definition.type))
    return Effect.acquireRelease(
      PubSub.unbounded<BusEvent>().pipe(
        Effect.tap((subscriber) =>
          Effect.sync(() => {
            for (const type of types) typed.set(type, (typed.get(type) ?? new Set()).add(subscriber))
          }),
        ),
      ),
      (subscriber) =>
        Effect.sync(() => {
          for (const type of types) {
            const subscribers = typed.get(type)
            subscribers?.delete(subscriber)
            if (subscribers?.size === 0) typed.delete(type)
          }
        }).pipe(Effect.andThen(PubSub.shutdown(subscriber))),
    ).pipe(Effect.flatMap(PubSub.subscribe))
  }

  const subscribe = ((definitions?: ReadonlyArray<{ readonly type: string }>) =>
    definitions === undefined ? PubSub.subscribe(pubsub) : subscribeTyped(definitions)) as Subscribe

  const transaction = <A, E, R>(body: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      if ((yield* Buffer) !== undefined) return yield* body
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const buffer = {
            events: [] as Array<BusEvent>,
            after: [] as Array<() => void>,
            fiberId: yield* Effect.fiberId,
            closed: false,
          }
          const result = yield* sql
            .withTransaction(restore(Effect.provideService(body, Buffer, buffer)))
            .pipe(Effect.ensuring(Effect.sync(() => (buffer.closed = true))))
          for (const apply of buffer.after) apply()
          yield* deliver(buffer.events)
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

  const aggregateOf = (definition: Definition, input: PublishInput<Definition>) =>
    Effect.gen(function* () {
      const { sessionId, projectId } = input
      if (definition.aggregate === "session" && sessionId !== undefined && projectId === undefined) return sessionId
      if (definition.aggregate === "project" && projectId !== undefined && sessionId === undefined) return projectId
      if (definition.aggregate === "ledger" && sessionId === undefined && projectId === undefined)
        return yield* ledgerId
      return yield* Effect.die(new Error(`${definition.type} belongs to a ${definition.aggregate} aggregate`))
    })

  const write = (aggregate: string, at: number, type: FactType, data: string) =>
    Effect.gen(function* () {
      const [row] = yield* sql<{ seq: number }>`INSERT INTO event (aggregate, seq, at, type, data)
        VALUES (${aggregate}, (SELECT coalesce(max(seq), 0) + 1 FROM event WHERE aggregate = ${aggregate}), ${at},
          ${type}, ${data}) RETURNING seq`
      const fact = yield* decodeRow({ aggregate, seq: row!.seq, at, type, data })
      yield* projectFact(fact)
      return fact
    })

  const publish = <D extends Definition>(definition: D, input: PublishInput<D>) =>
    transaction(
      Effect.gen(function* () {
        const buffer = yield* Buffer
        if (buffer === undefined || buffer.closed || (yield* Effect.fiberId) !== buffer.fiberId)
          return yield* Effect.die(new Error("publish not from the transaction fiber"))
        const aggregate = yield* aggregateOf(definition, input)
        const at = input.at ?? (yield* Clock.currentTimeMillis)
        const data = yield* encodeData(definition, input.data as never).pipe(Effect.orDie)
        const fact = yield* write(aggregate, at, definition.type, data).pipe(Effect.orDie)
        buffer.events.push(fact)
        return fact.seq
      }),
    )

  const observe = (signal: Signal) =>
    Effect.gen(function* () {
      const buffer = yield* Buffer
      if (buffer !== undefined && !buffer.closed) buffer.events.push(signal)
      else yield* deliver([signal])
    })

  const afterCommit = (apply: () => void) =>
    Effect.gen(function* () {
      const buffer = yield* Buffer
      if (buffer !== undefined && !buffer.closed) buffer.after.push(apply)
      else apply()
    })

  const log = (input: {
    readonly aggregate?: string | undefined
    readonly after?: number | undefined
    readonly follow: boolean
  }) => {
    const start: Cursor =
      input.aggregate === undefined ? { log: 0 } : { aggregate: input.aggregate, after: input.after ?? 0 }
    if (!input.follow) return followFacts(sql, Effect.void, start, false).pipe(Stream.orDie)
    return Stream.unwrap(
      Effect.gen(function* () {
        const wake = yield* Queue.sliding<void>(1)
        yield* Stream.fromSubscription(yield* subscribe(Object.values(Catalog))).pipe(
          Stream.runForEach((event) =>
            input.aggregate === undefined || event.aggregate === input.aggregate
              ? Queue.offer(wake, undefined)
              : Effect.void,
          ),
          Effect.forkScoped,
        )
        return followFacts(sql, Queue.take(wake), start, true).pipe(Stream.orDie)
      }),
    )
  }

  const replayFrom = (after: number): Effect.Effect<void, SqlError.SqlError | UnknownFact> =>
    readLog(sql, after).pipe(
      Effect.flatMap((rows) =>
        Effect.gen(function* () {
          for (const row of rows) yield* projectFact(yield* decodeRow(row))
          if (rows.length === REPLAY_PAGE) yield* replayFrom(rows[rows.length - 1]!.position)
        }),
      ),
    )

  const rebuild = sql.withTransaction(
    Effect.gen(function* () {
      yield* dropProjection(sql)
      for (const statement of PROJECTION_SCHEMA) yield* sql.unsafe(statement)
      yield* replayFrom(0)
      yield* setMeta(sql, "projection", PROJECTION_VERSION)
    }),
  )

  return { observe, subscribe, publish, transaction, afterCommit, log, project, rebuild }
})

export class Bus extends Context.Service<Bus, Effect.Success<typeof make>>()("vibest/Bus") {
  static readonly layer = Layer.effect(Bus, make)

  static readonly node = LayerNode.make({ service: Bus, layer: Bus.layer, deps: [PlatformNode.sqlClient] })
}

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
    const bus = yield* Bus
    const tables = Object.keys(PROJECTION_TABLES) as Array<keyof typeof PROJECTION_TABLES>
    const storedTables = yield* stored.withTransaction(
      Effect.gen(function* () {
        yield* copyWholeLog(stored, scratch)
        return yield* Effect.forEach(tables, (table) => dump(stored, table))
      }),
    )
    yield* bus.rebuild
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
      const scratch = yield* SqlClient.SqlClient
      yield* copyWholeLog(stored, scratch)
      return yield* (yield* Bus).rebuild
    }
    const difference = yield* equalToReplay(stored)
    if (difference !== undefined)
      return yield* new ReplayDiffers({ message: `the read model differs from a replay of its log: ${difference}` })
  })

export const awaitOn = <A, E, R>(
  subscription: PubSub.Subscription<BusEvent>,
  look: Effect.Effect<Option.Option<A>, E, R>,
  match: (event: BusEvent) => Effect.Effect<Option.Option<A>, E, R>,
  deadline: Duration.Duration,
  onDeadline: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => {
  const next: Effect.Effect<A, E, R> = PubSub.take(subscription).pipe(
    Effect.flatMap(match),
    Effect.flatMap((found) => (Option.isSome(found) ? Effect.succeed(found.value) : next)),
  )
  return look.pipe(
    Effect.flatMap((found) => (Option.isSome(found) ? Effect.succeed(found.value) : next)),
    Effect.timeoutOrElse({ duration: deadline, orElse: () => onDeadline }),
  )
}

export const awaitEvent = <A, E, R>(
  look: Effect.Effect<Option.Option<A>, E, R>,
  match: (event: BusEvent) => Effect.Effect<Option.Option<A>, E, R>,
  deadline: Duration.Duration,
  onDeadline: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, Exclude<R, Scope.Scope> | Bus> =>
  Effect.scoped(
    Effect.gen(function* () {
      const subscription = yield* (yield* Bus).subscribe()
      return yield* awaitOn(subscription, look, match, deadline, onDeadline)
    }),
  )

export const withChanges = (events: ReadonlyArray<BusEvent>): ReadonlyArray<BusEvent> => {
  const sessions = new Set<string>()
  const projects = new Set<string>()
  for (const event of events) {
    if (event.type === "session.changed") sessions.add(event.sessionId)
    else if (event.type === "project.changed") projects.add(event.projectId)
  }
  const changes: Array<BusEvent> = []
  for (const event of events) {
    if (!("seq" in event)) continue
    if (event.sessionId !== undefined && !sessions.has(event.sessionId)) {
      sessions.add(event.sessionId)
      changes.push({ type: "session.changed", sessionId: event.sessionId })
    }
    if (event.projectId !== undefined && !projects.has(event.projectId)) {
      projects.add(event.projectId)
      changes.push({ type: "project.changed", projectId: event.projectId })
    }
  }
  return [...events, ...changes]
}
