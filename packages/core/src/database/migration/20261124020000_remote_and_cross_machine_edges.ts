import { Effect, Option, Schema } from "effect"
import type { SqlClient } from "effect/sql"

const optional = <S extends Schema.Top>(schema: S) => Schema.optionalKey(schema)

const JsonRecord = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))
const decodeRecord = (data: string) => Schema.decodeUnknownEffect(JsonRecord)(data).pipe(Effect.orDie)

const LegacyOrigin = Schema.Struct({
  peer: optional(Schema.String),
  remote: optional(Schema.String),
  project: Schema.String,
  session: optional(Schema.String),
})

const LinkedPayload = Schema.Struct({
  to: Schema.String,
  remote: optional(Schema.String),
})

const LegacyMachineAdded = Schema.Struct({
  vibestd: Schema.String,
})

const LegacyOutbox = Schema.Struct({
  peer: Schema.String,
})

const decodeOrigin = Schema.decodeUnknownOption(LegacyOrigin)
const decodeLinked = Schema.decodeUnknownOption(LinkedPayload)
const decodeMachineAdded = Schema.decodeUnknownOption(LegacyMachineAdded)
const decodeOutbox = Schema.decodeUnknownOption(LegacyOutbox)

type EventRow = {
  readonly position: number
  readonly aggregate: string
  readonly at: number
  readonly type: string
  readonly data: string
}

export const migration = {
  id: "20261124020000_remote_and_cross_machine_edges",
  up: (tx: SqlClient.SqlClient) =>
    Effect.gen(function* () {
      yield* tx`UPDATE event SET type = 'remote.seen' WHERE type = 'peer.seen'`

      const createdRows = yield* tx<EventRow>`SELECT position, aggregate, at, type, data FROM event
        WHERE type = 'session.created' ORDER BY position`

      const remoteEdgesToAdd: Array<{
        readonly from: string
        readonly to: string
        readonly remote: string
        readonly at: number
      }> = []

      for (const row of createdRows) {
        const record = yield* decodeRecord(row.data)
        const parsed = decodeOrigin(record["origin"])

        if (Option.isNone(parsed)) continue
        const origin = parsed.value
        const remote = origin.remote ?? origin.peer

        if (remote === undefined) continue

        if (origin.peer !== undefined) {
          const next = {
            ...record,
            origin: {
              remote,
              project: origin.project,
              ...(origin.session !== undefined && { session: origin.session }),
            },
          }

          yield* tx`UPDATE event SET data = ${JSON.stringify(next)} WHERE position = ${row.position}`
        }

        if (origin.session !== undefined)
          remoteEdgesToAdd.push({ from: row.aggregate, to: origin.session, remote, at: row.at })
      }

      const existingLinked = yield* tx<{ aggregate: string; data: string }>`SELECT aggregate, data FROM event
        WHERE type = 'session.linked'`

      const linkedKeys = new Set<string>()

      for (const row of existingLinked) {
        const parsed = decodeLinked(yield* decodeRecord(row.data))

        if (Option.isSome(parsed)) linkedKeys.add(`${row.aggregate}\0${parsed.value.remote ?? ""}\0${parsed.value.to}`)
      }

      for (const edge of remoteEdgesToAdd) {
        const key = `${edge.from}\0${edge.remote}\0${edge.to}`

        if (linkedKeys.has(key)) continue
        linkedKeys.add(key)

        const [seqRow] = yield* tx<{ maxSeq: number }>`SELECT coalesce(max(seq), 0) AS maxSeq
          FROM event WHERE aggregate = ${edge.from}`

        const seq = (seqRow?.maxSeq ?? 0) + 1

        yield* tx`INSERT INTO event (aggregate, seq, at, type, data)
          VALUES (${edge.from}, ${seq}, ${edge.at}, 'session.linked',
            ${JSON.stringify({ to: edge.to, remote: edge.remote })})`
      }

      const machineRows = yield* tx<EventRow>`SELECT position, aggregate, at, type, data FROM event
        WHERE type = 'machine.added' ORDER BY position`

      for (const row of machineRows) {
        const record = yield* decodeRecord(row.data)
        const parsed = decodeMachineAdded(record)

        if (Option.isNone(parsed)) continue
        const { vibestd: _vibestd, ...rest } = record
        yield* tx`UPDATE event SET data = ${JSON.stringify({ ...rest, remote: parsed.value.vibestd })} WHERE position = ${row.position}`
      }

      const outboxRows = yield* tx<EventRow>`SELECT position, aggregate, at, type, data FROM event
        WHERE type IN ('outbox.queued', 'outbox.acked') ORDER BY position`

      for (const row of outboxRows) {
        const record = yield* decodeRecord(row.data)
        const parsed = decodeOutbox(record)

        if (Option.isNone(parsed)) continue
        const { peer: _peer, ...rest } = record
        yield* tx`UPDATE event SET data = ${JSON.stringify({ ...rest, remote: parsed.value.peer })} WHERE position = ${row.position}`
      }
    }),
}
