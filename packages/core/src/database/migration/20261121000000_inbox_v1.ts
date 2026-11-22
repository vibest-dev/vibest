import { Effect, Schema } from "effect"
import type { SqlClient } from "effect/sql"

const optional = <S extends Schema.Top>(schema: S) => Schema.optionalKey(schema)

const Sender = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("agent"),
    session: Schema.String,
    agent: optional(Schema.String),
    title: optional(Schema.String),
    machine: optional(Schema.String),
  }),
  Schema.Struct({ type: Schema.Literal("plugin"), plugin: Schema.String }),
  Schema.Struct({ type: Schema.Literal("vibest") }),
  Schema.Struct({ type: Schema.Literal("user") }),
])

const Queued = Schema.Struct({
  kind: Schema.Literals(["task", "send", "notice"]),
  sender: Sender,
  about: optional(Schema.String),
  content: Schema.String,
  status: Schema.Literals(["pending", "delivered", "dropped"]),
  request: optional(Schema.String),
  peerItem: optional(Schema.String),
  execution: optional(Schema.Number),
})

const Moved = Schema.Struct({
  inbox: Schema.Number,
  to: Schema.Literals(["pending", "delivering", "delivered", "failed", "dropped"]),
  execution: optional(Schema.Number),
})

type Row = {
  readonly position: number
  readonly aggregate: string
  readonly seq: number
  readonly type: string
  readonly data: string
}

type Written = {
  readonly history?: string
  readonly sender?: typeof Sender.Type
  readonly content?: string
  readonly senderExecutionId?: number
  readonly requestId?: string
  readonly transferId?: string
  readonly aboutSessionId?: string
  readonly messageId?: number
  readonly execution?: number
  readonly recipientExecutionId?: number
  readonly reason?: string
}

const decode = <S extends Schema.Decoder<unknown>>(schema: S, row: Row) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(row.data).pipe(Effect.orDie)

const localSendExecution = (data: typeof Queued.Type) =>
  data.kind === "send" && data.sender.type === "agent" && data.sender.machine === undefined ? data.execution : undefined

const bodyOf = (data: typeof Queued.Type): Written => {
  const execution = localSendExecution(data)
  const request = data.request
  const transfer = data.peerItem
  const about = data.about

  return {
    sender: data.sender,
    content: data.content,
    ...(execution !== undefined && { senderExecutionId: execution }),
    ...(request !== undefined && { requestId: request }),
    ...(transfer !== undefined && { transferId: transfer }),
    ...(about !== undefined && { aboutSessionId: about }),
  }
}

export const migration = {
  id: "20261121000000_inbox_v1",
  up: (tx: SqlClient.SqlClient) =>
    Effect.gen(function* () {
      const rows = yield* tx<Row>`SELECT position, aggregate, seq, type, data FROM event
        WHERE type IN ('session.created', 'inbox.queued', 'inbox.moved')
        ORDER BY position`

      const created = new Map<string, { position: number; seq: number }>()
      const delegation = new Map<string, number>()

      const replace = (row: Row, type: string, data: Written) =>
        tx`UPDATE event SET type = ${type}, data = ${JSON.stringify(data)} WHERE position = ${row.position}`

      for (const row of rows) {
        if (row.type === "session.created") {
          created.set(row.aggregate, { position: row.position, seq: row.seq })
          continue
        }

        if (row.type === "inbox.queued") {
          const data = yield* decode(Queued, row)
          const birth = created.get(row.aggregate)

          if (
            !delegation.has(row.aggregate) &&
            data.kind === "task" &&
            birth !== undefined &&
            row.seq === birth.seq + 1
          )
            delegation.set(row.aggregate, row.seq)
          const body = bodyOf(data)

          if (data.status === "dropped") {
            yield* replace(row, "inbox.unresolved", { history: "route", ...body })
            continue
          }

          yield* replace(row, "inbox.enqueued", body)
          continue
        }

        const data = yield* decode(Moved, row)
        const messageId = data.inbox

        if (data.to === "pending") {
          yield* replace(row, "inbox.unresolved", { history: "released", messageId })
          continue
        }

        if (data.to === "delivering") {
          yield* replace(row, "inbox.delivery_started", { messageId })
          continue
        }

        if (data.to === "delivered" && data.execution !== undefined) {
          yield* replace(row, "inbox.unresolved", { history: "unconfirmed", messageId, execution: data.execution })
          continue
        }

        if (data.to === "delivered") {
          yield* replace(row, "inbox.unresolved", { history: "delivered_without_execution", messageId })
          continue
        }

        if (data.to === "failed") {
          yield* replace(row, "inbox.unresolved", { history: "failed_unspecified", messageId })
          continue
        }

        yield* replace(row, "inbox.dropped", { messageId, reason: "unrecorded" })
      }

      for (const [aggregate, seq] of delegation) {
        const birth = created.get(aggregate)

        if (birth !== undefined)
          yield* tx`UPDATE event SET data = json_patch(data, ${JSON.stringify({ message: seq })})
            WHERE position = ${birth.position}`
      }
    }),
}
