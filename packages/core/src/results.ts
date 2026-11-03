import type { IntegrationEvent } from "@vibest/protocol/protocol"
// Result files and turn-report lines, written by vibestd alone from the turn events the integrations send it (SPEC §5.3,
// runtime-port.md §5), and the session report format.
import { Effect, FileSystem, Option, Path, Schema } from "effect"

import type { HarnessId } from "./harness.ts"
import { Layout, writeAtomic } from "./paths.ts"

/** `{harness, ts, payload}`; payload is the harness's hook input, verbatim. */
const Envelope = Schema.fromJsonString(
  Schema.Struct({
    harness: Schema.String,
    ts: Schema.Number,
    payload: Schema.Record(Schema.String, Schema.Unknown),
  }),
)
const decodeEnvelope = Schema.decodeUnknownEffect(Envelope)

export type TurnResult = {
  readonly harness: HarnessId
  readonly mtimeMs: number
  readonly text: string
  readonly error: string | undefined
  /** A turn stopped in its terminal (`aborted: true`, Claude's and Pi's): a result only for an open round. */
  readonly interrupted: boolean
}

/** One line of `reports/<id>.jsonl` (runtime-port.md §5): a turn start with the user's prompt, or a turn end with the result. */
export type ReportLine =
  | { readonly turn: "start"; readonly ts: number; readonly prompt: string }
  | {
      readonly turn: "end"
      readonly ts: number
      readonly harness: HarnessId
      readonly payload: Readonly<Record<string, unknown>>
    }

const encodeReportLine = (line: ReportLine) => `${JSON.stringify(line)}\n`

const ReportLineJson = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({ turn: Schema.Literals(["start"]), ts: Schema.Number, prompt: Schema.String }),
    Schema.Struct({
      turn: Schema.Literals(["end"]),
      ts: Schema.Number,
      harness: Schema.String,
      payload: Schema.Record(Schema.String, Schema.Unknown),
    }),
  ]),
)

/** Append one report line (runtime-port.md §5). One write, append mode; a lost line is only a lost fast path. */
const appendReportLine = (file: string, line: ReportLine) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    yield* fs.makeDirectory(path.dirname(file), { recursive: true })
    yield* fs.writeFileString(file, encodeReportLine(line), { flag: "a" })
  })

export const jsonObject = (raw: string): Record<string, unknown> | undefined => {
  try {
    const value = JSON.parse(raw) as unknown
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
    return value as Record<string, unknown>
  } catch {
    return undefined
  }
}

/** A neutral turn end (`IntegrationEvent` turn.end). */
export type IntegrationTurnEnd = Extract<IntegrationEvent, { readonly type: "turn.end" }>

/** A turn end as the result payload vibest keeps: the reply, and what ended it (`rate_limit` for a usage limit). */
export const resultPayload = (end: IntegrationTurnEnd): Readonly<Record<string, unknown>> => {
  const text = end.text ?? ""
  if (end.outcome === "completed") return { text }
  if (end.outcome === "interrupted")
    return {
      text,
      aborted: true,
      error: "interrupted",
      error_details: "the turn was stopped in its terminal (Esc) before it ended",
    }
  const kind = end.failure?.kind
  return {
    text,
    error: kind === "limited" ? "rate_limit" : kind === "auth" ? "auth" : "error",
    error_details: end.failure?.message ?? "the turn ended on an error",
  }
}

/** A session's turn end: its result file and its turn-end report line. False for a session id that is not one file name. */
export const recordTurnEnd = (harness: HarnessId, sessionId: string, end: IntegrationTurnEnd) =>
  Effect.gen(function* () {
    const layout = yield* Layout
    const path = yield* Path.Path
    const file = layout.resultFile(sessionId)
    // The session id comes from the caller. Keep the file as one name inside the results directory.
    if (path.basename(file) !== `${sessionId}.json` || path.dirname(file) !== layout.results) return false
    const payload = resultPayload(end)
    yield* writeAtomic(file, JSON.stringify({ harness, ts: Math.floor(Date.now() / 1000), payload }))
    yield* appendReportLine(layout.reportFile(sessionId), { turn: "end", ts: Date.now(), harness, payload })
    return true
  })

/** The prompt's turn-start report line, at `ts`: never older than the stamp vibestd gives the round. */
export const recordPrompt = (sessionId: string, text: string, ts = Date.now()) =>
  Effect.flatMap(Layout, (layout) =>
    appendReportLine(layout.reportFile(sessionId), { turn: "start", ts, prompt: text }),
  )

/** Every report line of a session, oldest first; unreadable lines are skipped, a missing file is empty. */
export const readReportLines = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const text = yield* fs.readFileString(file).pipe(Effect.option)
    if (Option.isNone(text)) return [] as ReadonlyArray<ReportLine>
    const lines: Array<ReportLine> = []
    for (const raw of text.value.split("\n")) {
      if (raw.trim() === "") continue
      const line = yield* Effect.option(Schema.decodeUnknownEffect(ReportLineJson)(raw))
      if (Option.isSome(line)) lines.push(line.value)
    }
    return lines
  })

export { isUsageLimitError } from "@vibest/protocol/tools"

/** The last turn in a result file; None if missing, unreadable or not an vibest envelope. */
export const readResult = Effect.fn("readResult")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem
  return yield* Effect.gen(function* () {
    const info = yield* fs.stat(file)
    const envelope = yield* decodeEnvelope(yield* fs.readFileString(file))
    const text = envelope.payload.text
    const error = envelope.payload.error
    // `error` names what ended the turn (Claude's `interrupted`, `refusal`, `error`), `error_details` the text.
    const details = envelope.payload.error_details
    return {
      harness: envelope.harness,
      mtimeMs: Option.match(info.mtime, { onNone: () => 0, onSome: (d) => d.getTime() }),
      text: typeof text === "string" ? text : "",
      error:
        typeof error === "string" && error
          ? typeof details === "string" && details
            ? `${error}: ${details}`
            : error
          : undefined,
      interrupted: envelope.payload.aborted === true,
    } satisfies TurnResult
  }).pipe(Effect.option)
})

/** What vibest observed of a turn: `completed` when the harness ended it normally, `failed` on an error. Never the model's own words. */
export type ResultStatus = "completed" | "failed"

export interface Report {
  /** The first non-empty line of the final message, cut to about 120 characters; undefined when the message is empty. */
  readonly summary: string | undefined
  readonly remember: string | undefined
}

/** The final message's first non-empty line as its summary, and the optional `## Remember` section. */
export function parseReport(text: string): Report {
  const first = text
    .split("\n")
    .find((l) => l.trim() !== "")
    ?.trim()
  const summary = first && first.length > 120 ? `${first.slice(0, 119)}…` : first
  const remember = /^##\s*Remember\s*$([\s\S]*?)(?=^##\s|(?![\s\S]))/im.exec(text)?.[1]!.trim()
  return { summary, remember: remember || undefined }
}

const escapeText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

/**
 * A result or message as the coordinator reads it, shaped like Claude Code's task notifications: one child element per
 * field (empty ones left out), then the agent's own text, unescaped.
 */
export const envelope = (
  tag: string,
  fields: ReadonlyArray<readonly [string, string]>,
  text: readonly [tag: string, body: string],
) =>
  [
    `<${tag}>`,
    ...fields.filter(([, v]) => v !== "").map(([k, v]) => `<${k}>${escapeText(v)}</${k}>`),
    `<${text[0]}>`,
    text[1],
    `</${text[0]}>`,
    `</${tag}>`,
  ].join("\n")

/** vibest's one-line outcome of a turn, from any error; used as the summary when the final message is empty or the turn failed. */
export const outcome = (name: string, error: string | undefined) =>
  error ? `Agent "${name}" failed: ${error}` : `Agent "${name}" finished`
