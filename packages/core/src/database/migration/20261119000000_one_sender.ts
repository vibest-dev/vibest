import { Effect, Schema } from "effect"
import type { SqlClient } from "effect/sql"

const optional = <S extends Schema.Top>(schema: S) => Schema.optionalKey(schema)

const Agent = Schema.Struct({
  session: Schema.String,
  agent: optional(Schema.String),
  title: optional(Schema.String),
  machine: optional(Schema.String),
})

type Agent = typeof Agent.Type

const Created = Schema.Struct({
  parent: optional(Schema.String),
  origin: optional(Schema.Struct({ peer: Schema.String, session: optional(Schema.String) })),
})

const Ended = Schema.Struct({ execution: Schema.Number })
const MachineAdded = Schema.Struct({ vibestd: Schema.String, name: Schema.String })
const PeerSeen = Schema.Struct({ id: Schema.String, name: Schema.String })

const InboxQueued = Schema.Struct({
  kind: Schema.Literals(["task", "send", "notice"]),
  sender: optional(Schema.String),
  from: optional(Agent),
})

const OutboxQueued = Schema.Struct({ kind: optional(Schema.String), session: Schema.String })

type Row = {
  readonly position: number
  readonly aggregate: string
  readonly seq: number
  readonly type: string
  readonly data: string
}

const decode = <S extends Schema.Decoder<unknown>>(schema: S, row: Row) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(row.data).pipe(Effect.orDie)

const ledger = (tx: SqlClient.SqlClient) => {
  const open = new Map<string, number>()
  const origins = new Map<string, { readonly peer: string; readonly session: string }>()
  const machines = new Map<string, string>()
  const peers = new Map<string, string>()
  const nameOf = (peer: string) => machines.get(peer) ?? peers.get(peer) ?? peer

  const patch = (
    row: Row,
    changes: {
      readonly sender?: Agent | "user" | "vibest"
      readonly about?: string | null
      readonly from?: null
      readonly execution?: number | null
    },
  ) => tx`UPDATE event SET data = json_patch(data, ${JSON.stringify(changes)}) WHERE position = ${row.position}`

  const senderOf = (data: typeof InboxQueued.Type, recipient: string): Agent | "user" => {
    if (data.from !== undefined) return data.from

    if (data.sender !== undefined) return { session: data.sender }
    const origin = origins.get(recipient)

    return data.kind === "task" && origin !== undefined
      ? { session: origin.session, machine: nameOf(origin.peer) }
      : "user"
  }

  const inbox = (row: Row, data: typeof InboxQueued.Type) => {
    if (data.kind === "notice") return patch(row, { sender: "vibest", about: data.sender ?? null })
    const sender = senderOf(data, row.aggregate)
    const local = sender !== "user" && sender.machine === undefined ? sender.session : undefined
    const execution = data.kind === "send" && local !== undefined ? open.get(local) : undefined

    return patch(row, { sender, from: null, execution: execution ?? null })
  }

  return (row: Row) =>
    Effect.gen(function* () {
      switch (row.type) {
        case "session.created": {
          const data = yield* decode(Created, row)

          if (data.parent === undefined && data.origin?.session !== undefined)
            origins.set(row.aggregate, { peer: data.origin.peer, session: data.origin.session })

          return
        }

        case "execution.started":
          open.set(row.aggregate, row.seq)

          return

        case "execution.ended": {
          const data = yield* decode(Ended, row)

          if (open.get(row.aggregate) === data.execution) open.delete(row.aggregate)

          return
        }

        case "machine.added": {
          const data = yield* decode(MachineAdded, row)
          machines.set(data.vibestd, data.name)

          return
        }

        case "peer.seen": {
          const data = yield* decode(PeerSeen, row)
          peers.set(data.id, data.name)

          return
        }

        case "inbox.queued":
          return yield* inbox(row, yield* decode(InboxQueued, row))

        case "outbox.queued": {
          const data = yield* decode(OutboxQueued, row)
          const execution = data.kind === "send" ? open.get(data.session) : undefined

          if (execution !== undefined) yield* patch(row, { execution })
        }
      }
    })
}

export const migration = {
  id: "20261119000000_one_sender",
  up: (tx: SqlClient.SqlClient) =>
    Effect.gen(function* () {
      const rows = yield* tx<Row>`SELECT position, aggregate, seq, type, data FROM event
        WHERE type IN ('session.created', 'execution.started', 'execution.ended', 'inbox.queued', 'outbox.queued',
          'machine.added', 'peer.seen')
        ORDER BY position`

      const step = ledger(tx)

      for (const row of rows) yield* step(row)
    }),
}
