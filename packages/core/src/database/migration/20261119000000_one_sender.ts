import { Effect, Schema } from "effect"
import type { SqlClient } from "effect/sql"

const optional = <S extends Schema.Top>(schema: S) => Schema.optionalKey(schema)

const Agent = Schema.Struct({
  session: Schema.String,
  agent: optional(Schema.String),
  title: optional(Schema.String),
  machine: optional(Schema.String),
})

type Sender = ({ readonly type: "agent" } & typeof Agent.Type) | { readonly type: "user" } | { readonly type: "vibest" }

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
  request: optional(Schema.String),
})

const OutboxQueued = Schema.Struct({
  id: Schema.String,
  kind: optional(Schema.String),
  session: Schema.String,
  from: optional(Agent),
})

const relayed = (data: typeof OutboxQueued.Type) =>
  data.from !== undefined && (data.from.session !== data.session || data.from.machine !== undefined)

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
  const requests = new Set<string>()
  const outboxIds = new Set<string>()

  const patch = (
    row: Row,
    changes: {
      readonly sender?: Sender
      readonly about?: string | null
      readonly from?: null
      readonly execution?: number | null
      readonly request?: null
    },
  ) => tx`UPDATE event SET data = json_patch(data, ${JSON.stringify(changes)}) WHERE position = ${row.position}`

  const senderOf = (data: typeof InboxQueued.Type, recipient: string): Sender => {
    if (data.kind === "notice") return { type: "vibest" }

    if (data.from !== undefined) return { type: "agent", ...data.from }

    if (data.sender !== undefined) return { type: "agent", session: data.sender }
    const origin = origins.get(recipient)

    return data.kind === "task" && origin !== undefined
      ? { type: "agent", session: origin.session, machine: nameOf(origin.peer) }
      : { type: "user" }
  }

  const firstRequest = (sender: Sender, request: string | undefined) => {
    if (request === undefined) return true
    const key = `${sender.type === "agent" ? `${sender.machine ?? ""}/${sender.session}` : sender.type}\n${request}`

    if (requests.has(key)) return false
    requests.add(key)

    return true
  }

  const inbox = (row: Row, data: typeof InboxQueued.Type) => {
    const notice = data.kind === "notice"
    const sender = senderOf(data, row.aggregate)
    const local = sender.type === "agent" && sender.machine === undefined ? sender.session : undefined
    const execution = data.kind === "send" && local !== undefined ? open.get(local) : undefined

    return patch(row, {
      sender,
      from: null,
      ...(notice ? { about: data.sender ?? null } : { execution: execution ?? null }),
      ...(!firstRequest(sender, data.request) && { request: null }),
    })
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

          if (outboxIds.has(data.id)) return yield* tx`DELETE FROM event WHERE position = ${row.position}`
          outboxIds.add(data.id)
          const execution = data.kind === "send" ? open.get(data.session) : undefined

          if (execution !== undefined || relayed(data))
            yield* patch(row, {
              ...(execution !== undefined && { execution }),
              ...(relayed(data) && { from: null }),
            })
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
