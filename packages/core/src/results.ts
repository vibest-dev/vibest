// The session report format, a harness's turn input and the terminal status escape (runtime-port.md §5).
import { Effect, FileSystem } from "effect"

import { type HarnessAdapter } from "./harness.ts"

export const jsonObject = (raw: string): Record<string, unknown> | undefined => {
  try {
    const value = JSON.parse(raw) as unknown
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
    return value as Record<string, unknown>
  } catch {
    return undefined
  }
}

/** A harness plugin's prompt event: the text a round starts with, or undefined (the main agent, a nested agent, not the user). */
export const promptOf = (adapter: HarnessAdapter, agent: string, raw: string) => {
  const event = jsonObject(raw)
  const prompt = event && adapter.userPrompt?.(event, agent === "coordinator")
  return prompt?.text.trim() ? prompt.text : undefined
}

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
