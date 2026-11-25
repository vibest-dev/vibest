import { Schema } from "effect"

import { randomId } from "./id.ts"

export * as Event from "./event.ts"

export const ID = Schema.String.check(Schema.isStartingWith("evt_"))

export type ID = typeof ID.Type

export const createId = (at = Date.now()): ID =>
  `evt_${Math.max(0, Math.trunc(at)).toString(16).padStart(12, "0")}${randomId().replace(/-/g, "").slice(0, 16)}`

export const Seq = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

export type Seq = typeof Seq.Type

export const Version = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

export type Version = typeof Version.Type

export const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0))

export const DurableEnvelope = Schema.Struct({
  aggregateId: Schema.NonEmptyString,
  seq: Seq,
  version: Version,
})

export type DurableEnvelope = typeof DurableEnvelope.Type

export interface DurableMeta<Aggregate extends string = string, V extends number = number> {
  readonly aggregate: Aggregate
  readonly version: V
}

export type DurableDefinition<
  Type extends string = string,
  DataSchema extends Schema.Codec<unknown, unknown> = Schema.Codec<unknown, unknown>,
  Aggregate extends string = string,
  V extends number = number,
> = Schema.Top & {
  readonly type: Type
  readonly durability: "durable"
  readonly durable: DurableMeta<Aggregate, V>
  readonly data: DataSchema
}

export type EphemeralDefinition<
  Type extends string = string,
  DataSchema extends Schema.Codec<unknown, unknown> = Schema.Codec<unknown, unknown>,
> = Schema.Top & {
  readonly type: Type
  readonly durability: "ephemeral"
  readonly durable: undefined
  readonly data: DataSchema
}

export type Definition<
  Type extends string = string,
  DataSchema extends Schema.Codec<unknown, unknown> = Schema.Codec<unknown, unknown>,
> = DurableDefinition<Type, DataSchema> | EphemeralDefinition<Type, DataSchema>

export type Data<D extends Definition> = D["data"]["Type"]

export type Payload<D extends Definition = Definition> = D extends DurableDefinition
  ? {
      readonly id: ID
      readonly type: D["type"]
      readonly created: number
      readonly durable: DurableEnvelope
      readonly data: Data<D>
    }
  : {
      readonly id: ID
      readonly type: D["type"]
      readonly created: number
      readonly data: Data<D>
    }

export class InvalidDurableEvent extends Schema.TaggedError<InvalidDurableEvent>()("InvalidDurableEvent", {
  aggregateId: Schema.optional(Schema.String),
  seq: Schema.optional(Schema.Number),
  type: Schema.String,
  message: Schema.String,
}) {}

export const durable = <
  const Type extends string,
  const Fields extends Schema.Struct.Fields,
  const Aggregate extends keyof Fields & string,
  const V extends number,
>(input: {
  readonly type: Type
  readonly durable: DurableMeta<Aggregate, V>
  readonly schema: Fields
}) => {
  const data = Schema.Struct(input.schema)

  const envelope = Schema.Struct({
    aggregateId: Schema.NonEmptyString,
    seq: Seq,
    version: Schema.Literal(input.durable.version),
  })

  const schema = Schema.Struct({
    id: ID,
    type: Schema.Literal(input.type),
    created: Schema.Int,
    durable: envelope,
    data,
  })

  return Object.assign(schema, {
    type: input.type,
    durability: "durable" as const,
    durable: input.durable,
    data,
  })
}

export const ephemeral = <const Type extends string, const Fields extends Schema.Struct.Fields>(input: {
  readonly type: Type
  readonly schema: Fields
}) => {
  const data = Schema.Struct(input.schema)

  const schema = Schema.Struct({
    id: ID,
    type: Schema.Literal(input.type),
    created: Schema.Int,
    data,
  })

  return Object.assign(schema, {
    type: input.type,
    durability: "ephemeral" as const,
    durable: undefined,
    data,
  })
}

export const inventory = <const Definitions extends ReadonlyArray<Definition>>(...definitions: Definitions) =>
  Object.freeze(definitions)

export const versionedType = (type: string, version: number) => `${type}.${version}`

const readonlyMap = <Key, Value>(map: Map<Key, Value>): ReadonlyMap<Key, Value> => {
  const result: ReadonlyMap<Key, Value> = Object.freeze({
    get size() {
      return map.size
    },
    entries: () => map.entries(),
    forEach: (callback: (value: Value, key: Key, map: ReadonlyMap<Key, Value>) => void) =>
      map.forEach((value, key) => callback(value, key, result)),
    get: (key: Key) => map.get(key),
    has: (key: Key) => map.has(key),
    keys: () => map.keys(),
    values: () => map.values(),
    [Symbol.iterator]: () => map[Symbol.iterator](),
  })

  return result
}

export const latest = (definitions: ReadonlyArray<Definition>): ReadonlyMap<string, Definition> => {
  const map = new Map<string, Definition>()

  for (const definition of definitions) {
    const existing = map.get(definition.type)

    if (existing === undefined) {
      map.set(definition.type, definition)
      continue
    }

    if (definition.durable && existing.durable && definition.durable.version !== existing.durable.version) {
      if (definition.durable.version > existing.durable.version) map.set(definition.type, definition)
      continue
    }

    if (definition !== existing) throw new Error(`Duplicate latest event definition for ${definition.type}`)
  }

  return readonlyMap(map)
}

const isDurable = <D extends Definition>(definition: D): definition is Extract<D, DurableDefinition> =>
  definition.durability === "durable"

export const durableMap = <const D extends Definition>(
  definitions: ReadonlyArray<D>,
): ReadonlyMap<string, Extract<D, DurableDefinition>> => {
  const map = new Map<string, Extract<D, DurableDefinition>>()

  for (const definition of definitions) {
    if (!isDurable(definition)) continue
    const key = versionedType(definition.type, definition.durable.version)

    if (map.has(key)) throw new Error(`Duplicate durable event definition for ${key}`)
    map.set(key, definition)
  }

  return readonlyMap(map)
}

const Text = Schema.NonEmptyString
const optional = <S extends Schema.Top>(schema: S) => Schema.optionalKey(schema)

export const AgentFrom = Schema.Struct({
  session: Schema.String,
  agent: optional(Schema.String),
  title: optional(Schema.String),
  machine: optional(Schema.String),
})

export type AgentFrom = typeof AgentFrom.Type

export const AgentSender = Schema.Struct({ type: Schema.Literal("agent"), ...AgentFrom.fields })

export type AgentSender = typeof AgentSender.Type

export const PluginSender = Schema.Struct({ type: Schema.Literal("plugin"), plugin: Text })

export const Sender = Schema.Union([
  AgentSender,
  PluginSender,
  Schema.Struct({ type: Schema.Literal("vibest") }),
  Schema.Struct({ type: Schema.Literal("user") }),
])

export type Sender = typeof Sender.Type

export const ProcessEndReason = Schema.Literals([
  "exited",
  "restart",
  "move",
  "archived",
  "launch_failed",
  "superseded",
  "stopped",
])

export type ProcessEndReason = typeof ProcessEndReason.Type

export const ExecutionOutcome = Schema.Literals(["completed", "failed", "interrupted", "lost", "not_started"])

export type ExecutionOutcome = typeof ExecutionOutcome.Type

export const ExecutionObservation = Schema.Literals(["lost", "not_started"])

export type ExecutionObservation = typeof ExecutionObservation.Type

export const ExecutionFailure = Schema.Struct({
  message: Text,
  kind: optional(Schema.Literal("limit")),
  resetAt: optional(Schema.Number),
})

export type ExecutionFailure = typeof ExecutionFailure.Type
