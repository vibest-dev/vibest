import {
  AllDurableDefinitions,
  type AnyDurableDefinition,
  decodeRow,
  type DurableEvent,
  type DurableEventOf,
  encodeJson,
  isDurableEventOf,
  type StoredRow,
} from "@vibest/schema/durable-event-manifest"
import { Event, InvalidDurableEvent } from "@vibest/schema/event"
import { McpEvent } from "@vibest/schema/mcp-event"
import { TerminalTarget } from "@vibest/schema/terminal"
import { LayerNode } from "@vibest/util/layer-node"
import {
  Clock,
  Context,
  type Duration,
  Effect,
  Layer,
  Option,
  Predicate,
  PubSub,
  Queue,
  Schema,
  type Scope,
  Stream,
} from "effect"
import { SqlClient, type SqlError } from "effect/sql"

import { LOG_SCHEMA, MIGRATION_TABLE, PROJECTION_SCHEMA, PROJECTION_TABLES } from "./database/schema.sql.ts"
import { PlatformNode } from "./effect/platform.ts"

export * as Bus from "./bus.ts"

const AgentStateSchema = Schema.Literals(["idle", "working", "blocked", "unknown"])

export const BoundProcessSchema = Schema.Struct({
  sessionId: Schema.String,
  process: Schema.Number,
})

export type BoundProcess = typeof BoundProcessSchema.Type

export const TerminalState = Event.ephemeral({
  type: "terminal.state",
  schema: {
    runtime: Schema.String,
    terminal: TerminalTarget,
    state: AgentStateSchema,
    processes: Schema.Array(BoundProcessSchema),
  },
})

export const TerminalExited = Event.ephemeral({
  type: "terminal.exited",
  schema: {
    runtime: Schema.String,
    terminal: TerminalTarget,
    processes: Schema.Array(BoundProcessSchema),
  },
})

export const TerminalSeen = Event.ephemeral({
  type: "terminal.seen",
  schema: {
    runtime: Schema.String,
    terminal: TerminalTarget,
  },
})

export const RuntimeReset = Event.ephemeral({
  type: "runtime.reset",
  schema: {
    runtime: Schema.String,
  },
})

export const DrainReleased = Event.ephemeral({
  type: "drain.released",
  schema: {},
})

export const SessionChanged = Event.ephemeral({
  type: "session.changed",
  schema: {
    sessionId: Schema.String,
  },
})

export const ProjectChanged = Event.ephemeral({
  type: "project.changed",
  schema: {
    projectId: Schema.String,
  },
})

export const EphemeralDefinitions = Event.inventory(
  TerminalState,
  TerminalExited,
  TerminalSeen,
  RuntimeReset,
  DrainReleased,
  SessionChanged,
  ProjectChanged,
  McpEvent.StatusChanged,
  McpEvent.ToolsChanged,
  McpEvent.ResourcesChanged,
  McpEvent.EventReceived,
)

export type AnyEphemeralDefinition = (typeof EphemeralDefinitions)[number]

export type EphemeralEvent = {
  readonly [D in AnyEphemeralDefinition as D["type"]]: Event.Payload<D>
}[AnyEphemeralDefinition["type"]]

export type BusEvent = DurableEvent | EphemeralEvent

export type Definition = AnyDurableDefinition

export type AnyBusDefinition = AnyDurableDefinition | AnyEphemeralDefinition

type EventOf<T extends BusEvent["type"]> = Extract<BusEvent, { readonly type: T }>

export interface Subscribe {
  (): Effect.Effect<PubSub.Subscription<BusEvent>, never, Scope.Scope>
  <T extends BusEvent["type"]>(
    definitions: ReadonlyArray<{ readonly type: T }>,
  ): Effect.Effect<PubSub.Subscription<EventOf<T>>, never, Scope.Scope>
}

export type Projector<D extends Definition> = (
  event: DurableEventOf<D["type"]>,
) => Effect.Effect<unknown, SqlError.SqlError>

export interface PublishOptions {
  readonly at?: number
}

interface TransactionBuffer {
  readonly events: Array<BusEvent>
  readonly after: Array<() => void>
  readonly fiberId: number
  closed: boolean
}

const Buffer = Context.Reference<TransactionBuffer | undefined>("vibest/BusBuffer", { defaultValue: () => undefined })

const REPLAY_PAGE = 1000

type Logged = StoredRow & { readonly position: number }

const readLog = (sql: SqlClient.SqlClient, after: number) =>
  sql<Logged>`SELECT position, id, aggregate_id, seq, created, type, data
    FROM event WHERE position > ${after} ORDER BY position LIMIT ${REPLAY_PAGE}`

type Cursor = { readonly aggregate: string; readonly after: number } | { readonly log: number }

type Step = readonly [ReadonlyArray<DurableEvent>, Cursor]

const readPage = (sql: SqlClient.SqlClient, cursor: Cursor, until: number | undefined) =>
  "aggregate" in cursor
    ? sql<Logged>`SELECT position, id, aggregate_id, seq, created, type, data
        FROM event WHERE aggregate_id = ${cursor.aggregate} AND seq > ${cursor.after} AND seq <= ${until ?? Number.MAX_SAFE_INTEGER}
        ORDER BY seq LIMIT ${REPLAY_PAGE}`
    : sql<Logged>`SELECT position, id, aggregate_id, seq, created, type, data
        FROM event WHERE position > ${cursor.log} AND position <= ${until ?? Number.MAX_SAFE_INTEGER}
        ORDER BY position LIMIT ${REPLAY_PAGE}`

const watermark = (sql: SqlClient.SqlClient, cursor: Cursor) => {
  const latest: Effect.Effect<ReadonlyArray<{ latest: number }>, SqlError.SqlError> = "aggregate" in cursor
    ? sql<{
        latest: number
      }>`SELECT coalesce(max(seq), 0) AS latest FROM event WHERE aggregate_id = ${cursor.aggregate}`
    : sql<{ latest: number }>`SELECT coalesce(max(position), 0) AS latest FROM event`

  return latest.pipe(Effect.map((rows) => rows[0]!.latest))
}

const advance = (cursor: Cursor, page: ReadonlyArray<Logged>): Cursor => {
  const last = page[page.length - 1]!

  return "aggregate" in cursor ? { aggregate: cursor.aggregate, after: last.seq } : { log: last.position }
}

const followEvents = (
  sql: SqlClient.SqlClient,
  wake: Effect.Effect<void>,
  start: Cursor,
  follow: boolean,
): Stream.Stream<DurableEvent, SqlError.SqlError | InvalidDurableEvent> =>
  Stream.unwrap(
    Effect.map(follow ? Effect.undefined : watermark(sql, start), (until) =>
      Stream.unfold(start, (cursor) =>
        readPage(sql, cursor, until).pipe(
          Effect.flatMap((page) =>
            page.length > 0
              ? Effect.forEach(page, decodeRow).pipe(Effect.map((decoded): Step => [decoded, advance(cursor, page)]))
              : follow
                ? wake.pipe(Effect.andThen(Effect.succeed<Step>([[], cursor])))
                : Effect.undefined,
          ),
        ),
      ).pipe(Stream.flattenIterable),
    ),
  )

const dropProjection = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const objects = yield* sql<{ type: string; name: string }>`SELECT type, name FROM sqlite_schema
      WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%'
        AND tbl_name NOT IN ('event', 'event_sequence', 'kv', ${MIGRATION_TABLE})
      ORDER BY type = 'index'`

    for (const object of objects)
      yield* sql.unsafe(`DROP ${object.type === "table" ? "TABLE" : "INDEX"} IF EXISTS "${object.name}"`)
  })

const aggregateIdOf = (definition: AnyDurableDefinition, data: Event.Data<AnyBusDefinition>) => {
  const field = definition.durable.aggregate

  if (Predicate.hasProperty(data, field)) {
    const value = data[field]

    if (Predicate.isString(value) && value.length > 0) return Effect.succeed(value)
  }

  return Effect.die(
    new InvalidDurableEvent({
      type: definition.type,
      message: `${definition.type} is missing string aggregate field ${definition.durable.aggregate}`,
    }),
  )
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const pubsub = yield* PubSub.unbounded<BusEvent>()
  const typed = new Map<string, Set<PubSub.PubSub<BusEvent>>>()
  const projectors = new Map<string, (event: DurableEvent) => ReturnType<Projector<Definition>>>()

  const project = Effect.fn("Bus.project")(<D extends Definition>(definition: D, projector: Projector<D>) =>
    Effect.sync(
      () =>
        void projectors.set(Event.versionedType(definition.type, definition.durable.version), (event) =>
          isDurableEventOf<D["type"]>(definition.type, event)
            ? projector(event)
            : Effect.die(new Error(`${event.type} reached the ${definition.type} projector`)),
        ),
    ),
  )

  const projectEvent = (event: DurableEvent): Effect.Effect<unknown, SqlError.SqlError | InvalidDurableEvent> => {
    const key = Event.versionedType(event.type, event.durable.version)
    const projector = projectors.get(key)

    return projector === undefined
      ? Effect.fail(
          new InvalidDurableEvent({
            aggregateId: event.durable.aggregateId,
            seq: event.durable.seq,
            type: key,
            message: `event ${event.durable.aggregateId} ${event.durable.seq}: ${key} has no projector`,
          }),
        )
      : projector(event)
  }

  const replayEvent = (event: DurableEvent): Effect.Effect<void, InvalidDurableEvent> =>
    Effect.asVoid(projectEvent(event)).pipe(
      Effect.mapError((error) =>
        error instanceof InvalidDurableEvent
          ? error
          : new InvalidDurableEvent({
              aggregateId: event.durable.aggregateId,
              seq: event.durable.seq,
              type: Event.versionedType(event.type, event.durable.version),
              message: `event ${event.durable.aggregateId} ${event.durable.seq}: ${event.type} cannot be projected: ${error.message}`,
            }),
      ),
    )

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

  function subscribe(): Effect.Effect<PubSub.Subscription<BusEvent>, never, Scope.Scope>
  function subscribe<T extends BusEvent["type"]>(
    definitions: ReadonlyArray<{ readonly type: T }>,
  ): Effect.Effect<PubSub.Subscription<EventOf<T>>, never, Scope.Scope>
  function subscribe(definitions?: ReadonlyArray<{ readonly type: string }>) {
    return definitions === undefined ? PubSub.subscribe(pubsub) : subscribeTyped(definitions)
  }

  const transaction = Effect.fn("Bus.transaction")(function* <A, E, R>(body: Effect.Effect<A, E, R>) {
    if ((yield* Buffer) !== undefined) return yield* body

    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const buffer: TransactionBuffer = {
          events: [],
          after: [],
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

  const writeDurable = (aggregateId: string, created: number, versionedType: string, data: string) =>
    Effect.gen(function* () {
      const [sequence] = yield* sql<{ seq: number }>`INSERT INTO event_sequence (aggregate_id, seq)
        VALUES (${aggregateId}, 1)
        ON CONFLICT(aggregate_id) DO UPDATE SET seq = seq + 1
        RETURNING seq`

      const id = Event.createId(created)
      const seq = sequence!.seq
      yield* sql`INSERT INTO event (id, aggregate_id, seq, created, type, data)
        VALUES (${id}, ${aggregateId}, ${seq}, ${created}, ${versionedType}, ${data})`

      const event = yield* decodeRow({ id, aggregateId, seq, created, type: versionedType, data })
      yield* projectEvent(event)

      return event
    })

  function publish<D extends AnyBusDefinition>(
    definition: D,
    data: Event.Data<D>,
    options?: PublishOptions,
  ): Effect.Effect<Event.Payload<D>>
  function publish(
    definition: AnyBusDefinition,
    data: Event.Data<AnyBusDefinition>,
    options?: PublishOptions,
  ): Effect.Effect<BusEvent> {
    if (definition.durability === "ephemeral") {
      return Effect.gen(function* () {
        const created = options?.at ?? (yield* Clock.currentTimeMillis)
        const id = Event.createId(created)

        const event = yield* Schema.decodeUnknownEffect(definition)({
          id,
          type: definition.type,
          created,
          data,
        }).pipe(Effect.orDie)

        const buffer = yield* Buffer

        if (buffer !== undefined && !buffer.closed) buffer.events.push(event)
        else yield* deliver([event])

        return event
      }).pipe(Effect.withSpan("Bus.publish"))
    }

    return transaction(
      Effect.gen(function* () {
        const buffer = yield* Buffer

        if (buffer === undefined || buffer.closed || (yield* Effect.fiberId) !== buffer.fiberId)
          return yield* Effect.die(new Error("publish not from the transaction fiber"))
        const aggregateId = yield* aggregateIdOf(definition, data)
        const created = options?.at ?? (yield* Clock.currentTimeMillis)
        const encoded = yield* encodeJson(definition, data).pipe(Effect.orDie)
        const versioned = Event.versionedType(definition.type, definition.durable.version)
        const event = yield* writeDurable(aggregateId, created, versioned, encoded).pipe(Effect.orDie)
        buffer.events.push(event)

        return event
      }),
    ).pipe(Effect.orDie, Effect.withSpan("Bus.publish"))
  }

  const afterCommit = Effect.fn("Bus.afterCommit")(function* (apply: () => void) {
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

    if (!input.follow) return followEvents(sql, Effect.void, start, false).pipe(Stream.orDie)

    return Stream.unwrap(
      Effect.gen(function* () {
        const wake = yield* Queue.sliding<void>(1)
        yield* Stream.fromSubscription(yield* subscribe(AllDurableDefinitions)).pipe(
          Stream.runForEach((event) =>
            input.aggregate === undefined || event.durable.aggregateId === input.aggregate
              ? Queue.offer(wake, undefined)
              : Effect.void,
          ),
          Effect.forkScoped,
        )

        return followEvents(sql, Queue.take(wake), start, true).pipe(Stream.orDie)
      }),
    )
  }

  const replayFrom = (after: number): Effect.Effect<void, SqlError.SqlError | InvalidDurableEvent> =>
    readLog(sql, after).pipe(
      Effect.flatMap((rows) =>
        Effect.gen(function* () {
          for (const row of rows) yield* replayEvent(yield* decodeRow(row))

          if (rows.length === REPLAY_PAGE) yield* replayFrom(rows[rows.length - 1]!.position)
        }),
      ),
    )

  const rebuild = sql.withTransaction(
    Effect.gen(function* () {
      yield* dropProjection(sql)

      for (const statement of PROJECTION_SCHEMA) yield* sql.unsafe(statement)
      yield* replayFrom(0)
    }),
  )

  return { subscribe, publish, transaction, afterCommit, log, project, rebuild }
})

export type Interface = Effect.Success<typeof make>

export class Service extends Context.Service<Service, Interface>()("vibest/Bus") {}

export const layer = Layer.effect(Service, make)

export const node = LayerNode.make({ service: Service, layer, deps: [PlatformNode.sqlClient] })

type ProjectionRow = Readonly<Record<string, string | number | null>>

const dump = (sql: SqlClient.SqlClient, table: string, key: string) =>
  sql.unsafe<ProjectionRow>(`SELECT * FROM ${table} ORDER BY ${key}`)

const copyLog = (
  from: SqlClient.SqlClient,
  to: SqlClient.SqlClient,
  after: number,
): Effect.Effect<void, SqlError.SqlError> =>
  readLog(from, after).pipe(
    Effect.flatMap((rows) =>
      Effect.gen(function* () {
        for (const row of rows)
          yield* to`INSERT INTO event (position, id, aggregate_id, seq, created, type, data)
            VALUES (${row.position}, ${row.id}, ${row.aggregateId}, ${row.seq}, ${row.created}, ${row.type}, ${row.data})`

        if (rows.length === REPLAY_PAGE) yield* copyLog(from, to, rows[rows.length - 1]!.position)
      }),
    ),
  )

const copySequences = (from: SqlClient.SqlClient, to: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const rows = yield* from<{ aggregateId: string; seq: number }>`SELECT aggregate_id, seq FROM event_sequence`

    for (const row of rows)
      yield* to`INSERT INTO event_sequence (aggregate_id, seq) VALUES (${row.aggregateId}, ${row.seq})`
  })

const copyKv = (from: SqlClient.SqlClient, to: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const rows = yield* from<{ key: string; value: string }>`SELECT key, value FROM kv`

    for (const row of rows) yield* to`INSERT INTO kv (key, value) VALUES (${row.key}, ${row.value})`
  })

const firstDifference = (
  table: string,
  key: string,
  stored: ReadonlyArray<ProjectionRow>,
  replayed: ReadonlyArray<ProjectionRow>,
) => {
  for (let i = 0; i < Math.max(stored.length, replayed.length); i++) {
    const a = stored[i] === undefined ? undefined : JSON.stringify(stored[i])
    const b = replayed[i] === undefined ? undefined : JSON.stringify(replayed[i])

    if (a !== b) return `${table} row ${i + 1} (by ${key}): stored ${a ?? "nothing"}, replayed ${b ?? "nothing"}`
  }

  return undefined
}

export const copyWholeLog = (stored: SqlClient.SqlClient, scratch: SqlClient.SqlClient) =>
  scratch.withTransaction(
    Effect.gen(function* () {
      for (const statement of LOG_SCHEMA) yield* scratch.unsafe(statement)
      yield* copyKv(stored, scratch)
      yield* copySequences(stored, scratch)
      yield* copyLog(stored, scratch, 0)
    }),
  )

export const equalToReplay = (stored: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const scratch = yield* SqlClient.SqlClient
    const bus = yield* Service
    const tables = Object.entries(PROJECTION_TABLES)
    yield* scratch.unsafe("PRAGMA foreign_keys = ON")

    const storedTables = yield* stored.withTransaction(
      Effect.gen(function* () {
        yield* copyWholeLog(stored, scratch)

        return yield* Effect.forEach(tables, ([table, key]) => dump(stored, table, key))
      }),
    )

    yield* bus.rebuild

    for (const [i, [table, key]] of tables.entries()) {
      const difference = firstDifference(table, key, storedTables[i]!, yield* dump(scratch, table, key))

      if (difference !== undefined) return difference
    }

    return undefined
  })

export class ReplayDiffers extends Schema.TaggedError<ReplayDiffers>()("ReplayDiffers", {
  message: Schema.String,
}) {}

export const checkReplay = (stored: SqlClient.SqlClient) =>
  Effect.gen(function* () {
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
): Effect.Effect<A, E, Exclude<R, Scope.Scope> | Service> =>
  Effect.scoped(
    Effect.gen(function* () {
      const subscription = yield* (yield* Service).subscribe()

      return yield* awaitOn(subscription, look, match, deadline, onDeadline)
    }),
  )

export const withChanges = (events: ReadonlyArray<BusEvent>): ReadonlyArray<BusEvent> => {
  const sessions = new Set<string>()
  const projects = new Set<string>()

  for (const event of events) {
    if (event.type === "session.changed") sessions.add(event.data.sessionId)
    else if (event.type === "project.changed") projects.add(event.data.projectId)
  }

  const changes: Array<BusEvent> = []

  for (const event of events) {
    if (!("durable" in event)) continue

    if (
      (event.type.startsWith("session.") || event.type.startsWith("process.")) &&
      !sessions.has(event.durable.aggregateId)
    ) {
      sessions.add(event.durable.aggregateId)
      changes.push({
        id: Event.createId(event.created),
        type: "session.changed",
        created: event.created,
        data: { sessionId: event.durable.aggregateId },
      })
    } else if (event.type.startsWith("project.") && !projects.has(event.durable.aggregateId)) {
      projects.add(event.durable.aggregateId)
      changes.push({
        id: Event.createId(event.created),
        type: "project.changed",
        created: event.created,
        data: { projectId: event.durable.aggregateId },
      })
    }
  }

  return [...events, ...changes]
}
