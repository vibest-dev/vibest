// Result files and turn-report lines written by the integrations (SPEC §5.3, runtime-port.md §5), and the session report format.
import { Effect, FileSystem, Option, Path, Schema } from "effect"
import { Harnesses, HARNESS_IDS, type HarnessId } from "./harness.ts"

/** `{harness, ts, payload}`; payload is the harness's hook input, verbatim. */
const Envelope = Schema.fromJsonString(
  Schema.Struct({
    harness: Schema.Literals(HARNESS_IDS),
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
  /** Cursor's `conversation_id` (in every hook's input), the id `--resume` takes; only a plain id, never one that reads as a flag. */
  readonly conversationId: string | undefined
}

/** One line of `reports/<id>.jsonl` (runtime-port.md §5): a turn start with the user's prompt, or a turn end with the result. */
export type ReportLine =
  | { readonly turn: "start"; readonly ts: number; readonly prompt: string }
  | { readonly turn: "end"; readonly ts: number; readonly harness: HarnessId; readonly payload: Readonly<Record<string, unknown>> }

export const encodeReportLine = (line: ReportLine) => `${JSON.stringify(line)}\n`

const ReportLineJson = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({ turn: Schema.Literals(["start"]), ts: Schema.Number, prompt: Schema.String }),
    Schema.Struct({ turn: Schema.Literals(["end"]), ts: Schema.Number, harness: Schema.Literals(HARNESS_IDS), payload: Schema.Record(Schema.String, Schema.Unknown) }),
  ]),
)

/** Append one report line (the integration side of runtime-port.md §5). One write, append mode; a lost line is only a lost fast path. */
export const appendReportLine = (file: string, line: ReportLine) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    yield* fs.makeDirectory(path.dirname(file), { recursive: true })
    yield* fs.writeFileString(file, encodeReportLine(line), { flag: "a" })
  })

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

/**
 * OSC 7501 to this process's terminal (runtime-port.md §5): the agent state as one escape sequence a terminal runtime
 * reads from the pane stream (rex and tern; herdr detects its own integration instead). Best effort on `/dev/tty`: no
 * terminal, or one that does not want it, changes nothing.
 */
export const writeTerminalStatus = (state: "working" | "idle" | "blocked") =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* Effect.gen(function* () {
      const handle = yield* fs.open("/dev/tty", { flag: "w" })
      yield* handle.write(new TextEncoder().encode(`\x1b]7501;${state}\x1b\\`))
    }).pipe(Effect.scoped, Effect.option)
  }).pipe(Effect.ignore)

/**
 * A limit code (`rate_limit`) or the provider's own limit text (`usage limit`, `too many requests`).
 * Only the text before the first colon is read; a message with no colon is read whole. Not `error_details`, not the answer.
 */
export const isUsageLimitError = (error: string | undefined) => {
  const head = error?.split(":")[0]
  return head !== undefined && head !== "" && /rate[_ -]?limits?\b|usage limits?\b|too many requests/i.test(head)
}

/** The last turn in a result file; None if missing, unreadable or not an vibest envelope. */
export const readResult = Effect.fn("readResult")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem
  return yield* Effect.gen(function* () {
    const info = yield* fs.stat(file)
    const envelope = yield* decodeEnvelope(yield* fs.readFileString(file))
    const text = envelope.payload[(yield* Harnesses).get(envelope.harness).resultField]
    const error = envelope.payload.error
    // Claude's StopFailure: `error` is a kind (`rate_limit`, `model_not_found`, ...), `error_details` the text.
    const details = envelope.payload.error_details
    const conversation = envelope.payload.conversation_id
    return {
      harness: envelope.harness,
      mtimeMs: Option.match(info.mtime, { onNone: () => 0, onSome: (d) => d.getTime() }),
      text: typeof text === "string" ? text : "",
      error: typeof error === "string" && error ? (typeof details === "string" && details ? `${error}: ${details}` : error) : undefined,
      conversationId: typeof conversation === "string" && /^\w[\w.:-]{0,127}$/.test(conversation) ? conversation : undefined,
    } satisfies TurnResult
  }).pipe(Effect.option)
})

export type ReportStatus = "completed" | "failed" | "needs_input" | "unknown"

export interface Report {
  readonly status: ReportStatus
  readonly summary: string | undefined
  readonly remember: string | undefined
}

/**
 * `status:` / `summary:` on any line (models sometimes put them last; full-width colon accepted), or right after a sentence
 * end (Cursor joins a turn's messages without a line break), and the optional `## Remember` section.
 */
export function parseReport(text: string): Report {
  const lines = text.split("\n")
  const field = (name: string) => {
    // Any leading non-word run: markdown emphasis, list bullets, a TUI's "⏺ " bullet.
    const re = new RegExp(`(?:^[^\\p{L}\\p{N}\\n]*|[.。!！?？]\\s*)${name}[*_]*\\s*[:：]\\s*(.+?)\\s*$`, "iu")
    for (const l of lines) {
      const m = re.exec(l)
      if (m) return m[1]!.replace(/^[*_\s]+|[*_\s]+$/g, "")
    }
  }
  const s = field("status")?.toLowerCase()
  const status: ReportStatus = s === "completed" || s === "failed" || s === "needs_input" ? s : "unknown"
  const remember = /^##\s*Remember\s*$([\s\S]*?)(?=^##\s|(?![\s\S]))/im.exec(text)?.[1]!.trim()
  return { status, summary: field("summary"), remember: remember || undefined }
}

const escapeText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

/**
 * A result or message as the coordinator reads it, shaped like Claude Code's task notifications: one child element per
 * field (empty ones left out), then the agent's own text, unescaped.
 */
export const envelope = (tag: string, fields: ReadonlyArray<readonly [string, string]>, text: readonly [tag: string, body: string]) =>
  [
    `<${tag}>`,
    ...fields.filter(([, v]) => v !== "").map(([k, v]) => `<${k}>${escapeText(v)}</${k}>`),
    `<${text[0]}>`,
    text[1],
    `</${text[0]}>`,
    `</${tag}>`,
  ].join("\n")

/** vibest's one-line outcome of a turn, from the report's status and any error. */
export const outcome = (name: string, status: ReportStatus, error: string | undefined) => {
  const agent = `Agent "${name}"`
  if (error) return `${agent} failed: ${error}`
  if (status === "completed") return `${agent} finished`
  if (status === "failed") return `${agent} reported a failure`
  if (status === "needs_input") return `${agent} is waiting for an answer`
  return `${agent} finished without a status line`
}
