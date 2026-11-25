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
  readonly oldSeq: number
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

export const migration = {
  id: "20261124050000_clean_event_catalog",
  up: (tx: SqlClient.SqlClient) =>
    Effect.gen(function* () {
      yield* tx`UPDATE event SET type = 'remote.outbox.queued' WHERE type = 'outbox.queued'`
      yield* tx`UPDATE event SET type = 'remote.outbox.acked' WHERE type = 'outbox.acked'`

      const aggregates = yield* tx<{ aggregate: string }>`SELECT DISTINCT aggregate FROM event
        WHERE type LIKE 'session.%' OR type LIKE 'process.%' OR type LIKE 'execution.%' OR type LIKE 'inbox.%'
        ORDER BY aggregate`

      for (const { aggregate } of aggregates) {
        const rows = yield* tx<EventRow>`SELECT position, aggregate, seq, at, type, data FROM event
          WHERE aggregate = ${aggregate} ORDER BY position`

        const decoded: Array<{ readonly row: EventRow; readonly record: JsonObject }> = []

        for (const row of rows) decoded.push({ row, record: yield* decodeRecord(row.data) })

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
        let structureChanged = false

        for (const { row, record } of decoded) {
          if (dropDeliveryStartedPositions.has(row.position)) {
            structureChanged = true
            continue
          }

          if (row.type === "execution.accepted") {
            structureChanged = true
            continue
          }

          if (row.type === "inbox.unresolved") {
            const history = record.history

            if (history === "route" && record.sender !== undefined && record.content !== undefined) {
              structureChanged = true
              out.push({
                oldSeq: row.seq,
                at: row.at,
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
              })
              out.push({
                oldSeq: -1,
                at: row.at,
                type: "session.inbox.dropped",
                data: { messageId: row.seq, reason: "route" },
                changed: true,
              })
              continue
            }

            if (history === "released") {
              structureChanged = true
              continue
            }

            if (history === "failed_unspecified" && Predicate.isNumber(record.messageId)) {
              out.push({
                oldSeq: row.seq,
                at: row.at,
                type: "session.inbox.failed",
                data: { messageId: record.messageId, reason: "unrecorded" },
                changed: true,
              })
              continue
            }

            if (
              (history === "unconfirmed" || history === "delivered_without_execution") &&
              Predicate.isNumber(record.messageId)
            ) {
              out.push({
                oldSeq: row.seq,
                at: row.at,
                type: "session.inbox.dropped",
                data: { messageId: record.messageId, reason: history },
                changed: true,
              })
              continue
            }

            structureChanged = true
            continue
          }

          if (row.type === "session.ended") {
            out.push({ oldSeq: row.seq, at: row.at, type: "session.archived", data: {}, changed: true })
            continue
          }

          if (row.type === "process.started") {
            const next = rewriteProcessStarted(record)
            out.push({ oldSeq: row.seq, at: row.at, type: row.type, data: next.data, changed: next.changed })
            continue
          }

          if (row.type === "process.placed" || row.type === "process.pid" || row.type === "process.conversation") {
            out.push({
              oldSeq: row.seq,
              at: row.at,
              type: "process.updated",
              data: pickProcessUpdated(record),
              changed: true,
            })
            continue
          }

          const renamed = SIMPLE_RENAMES.get(row.type)

          if (renamed !== undefined) {
            out.push({ oldSeq: row.seq, at: row.at, type: renamed, data: record, changed: true })
            continue
          }

          out.push({ oldSeq: row.seq, at: row.at, type: row.type, data: record, changed: false })
        }

        if (!structureChanged) {
          for (let i = 0; i < out.length; i++) {
            const item = out[i]!

            if (!item.changed) continue
            const original = rows[i]!
            yield* tx`UPDATE event SET type = ${item.type}, data = ${JSON.stringify(item.data)}
              WHERE position = ${original.position}`
          }

          continue
        }

        const seqMap = new Map<number, number>()

        for (let i = 0; i < out.length; i++) {
          const item = out[i]!

          if (item.oldSeq > 0) seqMap.set(item.oldSeq, i + 1)
        }

        yield* tx`DELETE FROM event WHERE aggregate = ${aggregate}`

        for (let i = 0; i < out.length; i++) {
          const item = out[i]!
          const remapped = remapData(item.type, item.data, seqMap)
          yield* tx`INSERT INTO event (aggregate, seq, at, type, data)
            VALUES (${aggregate}, ${i + 1}, ${item.at}, ${item.type}, ${JSON.stringify(remapped)})`
        }
      }
    }),
}
