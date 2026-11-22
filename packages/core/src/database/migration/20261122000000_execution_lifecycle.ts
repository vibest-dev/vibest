import { Effect, Schema } from "effect"
import type { SqlClient } from "effect/sql"

const optional = <S extends Schema.Top>(schema: S) => Schema.optionalKey(schema)

const Failure = Schema.Struct({
  message: Schema.String,
  kind: optional(Schema.Literal("limit")),
  resetAt: optional(Schema.Number),
})

const Started = Schema.Struct({
  process: optional(Schema.Number),
  typed: optional(Schema.String),
})

const Accepted = Schema.Struct({ execution: Schema.Number })

const Ended = Schema.Struct({
  execution: Schema.Number,
  outcome: Schema.Literals(["completed", "failed", "interrupted", "lost", "not_started"]),
  failure: optional(Failure),
  conversation: optional(Schema.String),
  reply: optional(Schema.String),
})

const ProcessStarted = Schema.Struct({ resume: optional(Schema.String) })
const ProcessConversation = Schema.Struct({ process: Schema.Number, conversation: Schema.String })

type Row = {
  readonly position: number
  readonly aggregate: string
  readonly seq: number
  readonly at: number
  readonly type: string
  readonly data: string
}

const decode = <S extends Schema.Decoder<unknown>>(schema: S, row: Row) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(row.data).pipe(Effect.orDie)

type Booking = { readonly process: number | undefined }

const key = (aggregate: string, execution: number) => `${aggregate}\n${execution}`

export const migration = {
  id: "20261122000000_execution_lifecycle",
  up: (tx: SqlClient.SqlClient) =>
    Effect.gen(function* () {
      const rows = yield* tx<Row>`SELECT position, aggregate, seq, at, type, data FROM event
        WHERE type IN ('execution.started', 'execution.accepted', 'execution.ended', 'process.started',
          'process.conversation')
        ORDER BY position`

      const booked = new Map<string, Booking>()
      const resumes = new Map<string, { readonly position: number; readonly resume: string | undefined }>()
      const conversations = new Map<string, Array<{ readonly position: number }>>()

      const carried: Array<{
        readonly aggregate: string
        readonly process: number
        readonly conversation: string
        readonly position: number
        readonly at: number
      }> = []

      type ExecutionFactData = {
        readonly executionId: number
        readonly processId?: number
        readonly typed?: string
        readonly reply?: string
        readonly reason?: string
        readonly observation?: "lost" | "not_started"
        readonly failure?: {
          readonly message: string
          readonly kind?: "limit"
          readonly resetAt?: number
        }
      }

      const replace = (row: Row, type: string, data: ExecutionFactData) =>
        tx`UPDATE event SET type = ${type}, data = ${JSON.stringify(data)} WHERE position = ${row.position}`

      const remembered = (aggregate: string, process: number) => conversations.get(key(aggregate, process)) ?? []

      for (const row of rows) {
        if (row.type === "process.started") {
          const data = yield* decode(ProcessStarted, row)
          resumes.set(key(row.aggregate, row.seq), { position: row.position, resume: data.resume })
          continue
        }

        if (row.type === "process.conversation") {
          const data = yield* decode(ProcessConversation, row)
          const id = key(row.aggregate, data.process)
          conversations.set(id, [...remembered(row.aggregate, data.process), { position: row.position }])
          continue
        }

        if (row.type === "execution.started") {
          const data = yield* decode(Started, row)
          booked.set(key(row.aggregate, row.seq), { process: data.process })
          yield* replace(row, "execution.allocated", {
            executionId: row.seq,
            processId: data.process,
            typed: data.typed,
          })
          continue
        }

        if (row.type === "execution.accepted") {
          const data = yield* decode(Accepted, row)
          const booking = booked.get(key(row.aggregate, data.execution))
          yield* replace(row, "execution.started", { executionId: data.execution, processId: booking?.process })
          continue
        }

        const data = yield* decode(Ended, row)
        const executionId = data.execution
        const reply = data.reply === "" ? undefined : data.reply
        const booking = booked.get(key(row.aggregate, executionId))

        if (data.outcome === "completed") yield* replace(row, "execution.succeeded", { executionId, reply })
        else if (data.outcome === "failed")
          yield* replace(row, "execution.failed", {
            executionId,
            failure: data.failure?.message ? data.failure : { message: "failed" },
            reply,
          })
        else if (data.outcome === "interrupted")
          yield* replace(row, "execution.interrupted", {
            executionId,
            reason: data.failure?.message,
            reply,
          })
        else
          yield* replace(row, "execution.unresolved", {
            executionId,
            observation: data.outcome,
            failure: data.failure?.message ? data.failure : undefined,
            reply,
          })

        if (data.conversation !== undefined && data.conversation !== "" && booking?.process !== undefined)
          carried.push({
            aggregate: row.aggregate,
            process: booking.process,
            conversation: data.conversation,
            position: row.position,
            at: row.at,
          })
      }

      for (const change of carried) {
        const known = remembered(change.aggregate, change.process)

        if (known.some((fact) => fact.position > change.position)) continue
        const prior = [...known].reverse().find((fact) => fact.position < change.position)

        if (prior !== undefined) {
          yield* tx`UPDATE event SET data = json_set(data, '$.conversation', ${change.conversation})
            WHERE position = ${prior.position}`
          continue
        }

        const started = resumes.get(key(change.aggregate, change.process))

        if (started !== undefined && (started.resume === undefined || started.resume === change.conversation)) {
          yield* tx`UPDATE event SET data = json_set(data, '$.resume', ${change.conversation})
            WHERE position = ${started.position}`
          continue
        }

        yield* tx`INSERT INTO event (aggregate, seq, at, type, data)
          SELECT ${change.aggregate}, coalesce(max(seq), 0) + 1, ${change.at}, 'process.conversation',
            ${JSON.stringify({ process: change.process, conversation: change.conversation })}
          FROM event WHERE aggregate = ${change.aggregate}`
      }
    }),
}
