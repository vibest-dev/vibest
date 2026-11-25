import { Effect, Option, Predicate, Schema } from "effect"
import type { SqlClient } from "effect/sql"

const JsonRecord = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))

type JsonObject = typeof JsonRecord.Type

const decodeRecord = (data: string) => Schema.decodeUnknownEffect(JsonRecord)(data).pipe(Effect.orDie)

const RoutingLegacy = Schema.Struct({
  decidedBy: Schema.Record(Schema.String, Schema.Unknown),
  trace: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
})

const decodeRouting = Schema.decodeUnknownOption(RoutingLegacy)

type EventRow = {
  readonly position: number
  readonly aggregate: string
  readonly seq: number
  readonly at: number
  readonly type: string
  readonly data: string
}

type OutRow = {
  readonly position: number
  readonly aggregate: string
  readonly oldSeq: number
  readonly at: number
  readonly type: string
  readonly data: JsonObject
  readonly changed: boolean
}

type FinalRow = {
  readonly position: number
  readonly aggregate: string
  readonly seq: number
  readonly at: number
  readonly type: string
  readonly data: JsonObject
  readonly changed: boolean
}

const SIMPLE_RENAMES = new Map<string, string>([
  ["execution.allocated", "session.execution.allocated"],
  ["execution.started", "session.execution.started"],
  ["execution.input", "session.execution.input"],
  ["execution.succeeded", "session.execution.succeeded"],
  ["execution.failed", "session.execution.failed"],
  ["execution.interrupted", "session.execution.interrupted"],
  ["execution.unresolved", "session.execution.unresolved"],
  ["inbox.enqueued", "session.inbox.enqueued"],
  ["inbox.delivery_started", "session.inbox.delivering"],
  ["inbox.delivered", "session.inbox.delivered"],
  ["inbox.delivery_failed", "session.inbox.failed"],
  ["inbox.dropped", "session.inbox.dropped"],
])

const rewriteProcessStarted = (record: JsonObject) => {
  const parsed = decodeRouting(record.routing)

  if (Option.isNone(parsed)) return { data: record, changed: false }
  const routing = parsed.value

  if (!routing.trace.some((entry) => entry.hook === "agent.start.before")) return { data: record, changed: false }

  const trace = routing.trace.map((entry) =>
    entry.hook === "agent.start.before" ? { ...entry, hook: "session.start.before" } : entry,
  )

  return { data: { ...record, routing: { ...routing, trace } }, changed: true }
}

const pickProcessUpdated = (record: JsonObject) => ({
  process: record.process,
  ...(record.terminal !== undefined && { terminal: record.terminal }),
  ...(record.pid !== undefined && { pid: record.pid }),
  ...(record.conversation !== undefined && { conversation: record.conversation }),
})

const remapData = (type: string, data: JsonObject, seqMap: ReadonlyMap<number, number>) => {
  const remap = (value: number) => seqMap.get(value) ?? value

  if (type === "session.created" && Predicate.isNumber(data.message)) return { ...data, message: remap(data.message) }

  if (
    (type === "process.ready" || type === "process.updated" || type === "process.ended") &&
    Predicate.isNumber(data.process)
  )
    return { ...data, process: remap(data.process) }

  if (type.startsWith("session.execution.") && Predicate.isNumber(data.processId))
    return { ...data, processId: remap(data.processId) }

  if (
    (type === "session.inbox.delivering" ||
      type === "session.inbox.delivered" ||
      type === "session.inbox.failed" ||
      type === "session.inbox.dropped") &&
    Predicate.isNumber(data.messageId)
  )
    return { ...data, messageId: remap(data.messageId) }

  return data
}

const isLaterSettlement = (row: EventRow, parsed: JsonObject, messageId: number): boolean => {
  if (row.type === "inbox.delivered" || row.type === "inbox.delivery_failed" || row.type === "inbox.dropped")
    return parsed.messageId === messageId

  if (row.type === "inbox.unresolved")
    return parsed.messageId === messageId && parsed.history !== "released" && parsed.history !== "route"

  return false
}

const transformRow = (row: EventRow, record: JsonObject): ReadonlyArray<OutRow> => {
  const base = { position: row.position, aggregate: row.aggregate, oldSeq: row.seq, at: row.at }

  if (row.type === "execution.accepted") return []

  if (row.type === "inbox.unresolved") {
    const history = record.history

    if (history === "route" && record.sender !== undefined && record.content !== undefined)
      return [
        {
          ...base,
          type: "session.inbox.enqueued",
          data: {
            sender: record.sender,
            content: record.content,
            ...(record.senderExecutionId !== undefined && { senderExecutionId: record.senderExecutionId }),
            ...(record.requestId !== undefined && { requestId: record.requestId }),
            ...(record.transferId !== undefined && { transferId: record.transferId }),
            ...(record.aboutSessionId !== undefined && { aboutSessionId: record.aboutSessionId }),
          },
          changed: true,
        },
        {
          ...base,
          oldSeq: -1,
          type: "session.inbox.dropped",
          data: { messageId: row.seq, reason: "route" },
          changed: true,
        },
      ]

    if (history === "failed_unspecified" && Predicate.isNumber(record.messageId))
      return [
        {
          ...base,
          type: "session.inbox.failed",
          data: { messageId: record.messageId, reason: "unrecorded" },
          changed: true,
        },
      ]

    if (
      (history === "unconfirmed" || history === "delivered_without_execution") &&
      Predicate.isNumber(record.messageId)
    )
      return [
        {
          ...base,
          type: "session.inbox.dropped",
          data: { messageId: record.messageId, reason: history },
          changed: true,
        },
      ]

    return []
  }

  if (row.type === "session.ended") return [{ ...base, type: "session.archived", data: {}, changed: true }]

  if (row.type === "process.started") {
    const next = rewriteProcessStarted(record)

    return [{ ...base, type: row.type, data: next.data, changed: next.changed }]
  }

  if (row.type === "process.placed" || row.type === "process.pid" || row.type === "process.conversation")
    return [{ ...base, type: "process.updated", data: pickProcessUpdated(record), changed: true }]

  const renamed = SIMPLE_RENAMES.get(row.type)

  return [
    renamed !== undefined
      ? { ...base, type: renamed, data: record, changed: true }
      : { ...base, type: row.type, data: record, changed: false },
  ]
}

export const migration = {
  id: "20261124050000_clean_event_catalog",
  up: (tx: SqlClient.SqlClient) =>
    Effect.gen(function* () {
      yield* tx`UPDATE event SET type = 'remote.outbox.queued' WHERE type = 'outbox.queued'`
      yield* tx`UPDATE event SET type = 'remote.outbox.acked' WHERE type = 'outbox.acked'`

      const aggregates = yield* tx<{ aggregate: string }>`SELECT DISTINCT aggregate FROM event
        WHERE type LIKE 'session.%' OR type LIKE 'process.%' OR type LIKE 'execution.%' OR type LIKE 'inbox.%'
        ORDER BY aggregate`

      const plans: Array<{
        readonly aggregate: string
        readonly deletedPositions: ReadonlyArray<number>
        readonly finalRows: ReadonlyArray<FinalRow>
      }> = []

      let anyExpanded = false

      for (const { aggregate } of aggregates) {
        const rows = yield* tx<EventRow>`SELECT position, aggregate, seq, at, type, data FROM event
          WHERE aggregate = ${aggregate} ORDER BY position`

        const decoded = yield* Effect.forEach(rows, (row) =>
          decodeRecord(row.data).pipe(Effect.map((record) => ({ row, record }))),
        )

        const dropDeliveryStartedPositions = new Set<number>()

        for (let i = 0; i < decoded.length; i++) {
          const current = decoded[i]!

          if (current.row.type !== "inbox.unresolved" || current.record.history !== "released") continue
          const messageId = current.record.messageId

          if (!Predicate.isNumber(messageId)) continue

          const settledLater = decoded
            .slice(i + 1)
            .some((later) => isLaterSettlement(later.row, later.record, messageId))

          if (settledLater) continue

          for (let j = 0; j < i; j++) {
            const earlier = decoded[j]!

            if (earlier.row.type === "inbox.delivery_started" && earlier.record.messageId === messageId)
              dropDeliveryStartedPositions.add(earlier.row.position)
          }
        }

        const out: Array<OutRow> = []
        const deletedPositions: Array<number> = []
        let expanded = false

        for (const { row, record } of decoded) {
          if (dropDeliveryStartedPositions.has(row.position)) {
            deletedPositions.push(row.position)
            continue
          }

          const emitted = transformRow(row, record)

          if (emitted.length === 0) {
            deletedPositions.push(row.position)
            continue
          }

          if (emitted.length > 1) expanded = true
          out.push(...emitted)
        }

        if (expanded) anyExpanded = true
        const structureChanged = deletedPositions.length > 0 || expanded

        const seqMap = new Map<number, number>()

        if (structureChanged) {
          for (let i = 0; i < out.length; i++) {
            const item = out[i]!

            if (item.oldSeq > 0) seqMap.set(item.oldSeq, i + 1)
          }
        }

        const finalRows: ReadonlyArray<FinalRow> = out.map((item, i) => ({
          position: item.position,
          aggregate: item.aggregate,
          seq: structureChanged ? i + 1 : item.oldSeq,
          at: item.at,
          type: item.type,
          data: structureChanged ? remapData(item.type, item.data, seqMap) : item.data,
          changed: structureChanged || item.changed,
        }))

        plans.push({ aggregate, deletedPositions, finalRows })
      }

      if (!anyExpanded) {
        for (const plan of plans) {
          if (plan.deletedPositions.length === 0) {
            for (const row of plan.finalRows) {
              if (!row.changed) continue
              yield* tx`UPDATE event SET type = ${row.type}, data = ${JSON.stringify(row.data)}
                WHERE position = ${row.position}`
            }

            continue
          }

          for (const pos of plan.deletedPositions) yield* tx`DELETE FROM event WHERE position = ${pos}`
          yield* tx`UPDATE event SET seq = -position WHERE aggregate = ${plan.aggregate}`

          for (const row of plan.finalRows)
            yield* tx`UPDATE event SET seq = ${row.seq}, type = ${row.type}, data = ${JSON.stringify(row.data)}
              WHERE position = ${row.position}`
        }

        return
      }

      const sessionAggregates = new Set(plans.map((plan) => plan.aggregate))
      const byPosition = new Map<number, Array<FinalRow>>()

      for (const plan of plans) {
        for (const row of plan.finalRows) {
          const list = byPosition.get(row.position) ?? []
          list.push(row)
          byPosition.set(row.position, list)
        }
      }

      const allRows = yield* tx<EventRow>`SELECT position, aggregate, seq, at, type, data FROM event ORDER BY position`

      const rewritten: Array<{
        readonly aggregate: string
        readonly seq: number
        readonly at: number
        readonly type: string
        readonly data: string
      }> = []

      for (const row of allRows) {
        if (!sessionAggregates.has(row.aggregate)) {
          rewritten.push({ aggregate: row.aggregate, seq: row.seq, at: row.at, type: row.type, data: row.data })
          continue
        }

        for (const emitted of byPosition.get(row.position) ?? [])
          rewritten.push({
            aggregate: emitted.aggregate,
            seq: emitted.seq,
            at: emitted.at,
            type: emitted.type,
            data: JSON.stringify(emitted.data),
          })
      }

      yield* tx`DELETE FROM event`

      for (const row of rewritten)
        yield* tx`INSERT INTO event (aggregate, seq, at, type, data)
          VALUES (${row.aggregate}, ${row.seq}, ${row.at}, ${row.type}, ${row.data})`
    }),
}
