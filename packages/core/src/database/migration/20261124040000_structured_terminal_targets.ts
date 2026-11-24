import { Effect, Option, Predicate, Schema } from "effect"
import type { SqlClient } from "effect/sql"

const JsonRecord = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))
const decodeRecord = (data: string) => Schema.decodeUnknownEffect(JsonRecord)(data).pipe(Effect.orDie)

const ProcessStartedLegacy = Schema.Struct({
  runtime: Schema.String,
  terminal: Schema.optionalKey(Schema.Unknown),
})

const ProcessPlacedLegacy = Schema.Struct({
  process: Schema.Number,
  terminal: Schema.Unknown,
})

const decodeStarted = Schema.decodeUnknownOption(ProcessStartedLegacy)
const decodePlaced = Schema.decodeUnknownOption(ProcessPlacedLegacy)

const parseLegacyTerminal = (runtime: string | undefined, raw: string) => {
  if (runtime === "hc") {
    const at = raw.lastIndexOf("@")

    return at > 0 && at < raw.length - 1 ? { address: raw.slice(0, at), socket: raw.slice(at + 1) } : { address: raw }
  }

  if (runtime === "herdr") {
    const hash = raw.indexOf("#")
    const base = hash === -1 ? raw : raw.slice(0, hash)
    const hashName = hash === -1 ? undefined : raw.slice(hash + 1) || undefined
    const parts = base.split("/")

    if (parts.length === 2 && parts[0]! !== "" && parts[1]! !== "")
      return {
        session: parts[0]!,
        pane: parts[1]!,
        ...(hashName !== undefined && { name: hashName }),
      }

    if (parts.length === 3 && parts[0]! !== "" && parts[1]! !== "" && parts[2]! !== "")
      return {
        session: parts[0]!,
        pane: parts[1]!,
        name: parts[2]!,
      }

    return { id: raw }
  }

  if (runtime === "rex") {
    const slash = raw.indexOf("/")

    if (slash > 0 && slash < raw.length - 1) return { session: raw.slice(0, slash), block: raw.slice(slash + 1) }

    return { id: raw }
  }

  return { id: raw }
}

type EventRow = {
  readonly position: number
  readonly aggregate: string
  readonly seq: number
  readonly data: string
}

export const migration = {
  id: "20261124040000_structured_terminal_targets",
  up: (tx: SqlClient.SqlClient) =>
    Effect.gen(function* () {
      const runtimeByProcess = new Map<string, string>()

      const startedRows = yield* tx<EventRow>`SELECT position, aggregate, seq, data FROM event
        WHERE type = 'process.started' ORDER BY position`

      for (const row of startedRows) {
        const record = yield* decodeRecord(row.data)
        const parsed = decodeStarted(record)

        if (Option.isNone(parsed)) continue
        runtimeByProcess.set(`${row.aggregate}\0${row.seq}`, parsed.value.runtime)

        if (!Predicate.isString(parsed.value.terminal)) continue

        if (parsed.value.terminal === "") {
          const { terminal: _terminal, ...rest } = record
          yield* tx`UPDATE event SET data = ${JSON.stringify(rest)} WHERE position = ${row.position}`
          continue
        }

        const next = {
          ...record,
          terminal: parseLegacyTerminal(parsed.value.runtime, parsed.value.terminal),
        }

        yield* tx`UPDATE event SET data = ${JSON.stringify(next)} WHERE position = ${row.position}`
      }

      const placedRows = yield* tx<EventRow>`SELECT position, aggregate, seq, data FROM event
        WHERE type = 'process.placed' ORDER BY position`

      for (const row of placedRows) {
        const record = yield* decodeRecord(row.data)
        const parsed = decodePlaced(record)

        if (Option.isNone(parsed)) continue

        if (!Predicate.isString(parsed.value.terminal)) continue
        const runtime = runtimeByProcess.get(`${row.aggregate}\0${parsed.value.process}`)
        const raw = parsed.value.terminal === "" ? "unknown" : parsed.value.terminal

        const next = {
          ...record,
          terminal: parseLegacyTerminal(runtime, raw),
        }

        yield* tx`UPDATE event SET data = ${JSON.stringify(next)} WHERE position = ${row.position}`
      }
    }),
}
