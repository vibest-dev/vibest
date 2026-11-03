// The session report format (SPEC §5.3). A turn's end reaches vibestd as a neutral event and is kept in memory
// (turn-ends.ts) until the session's check writes it as a `turn.end` event.

export const jsonObject = (raw: string): Record<string, unknown> | undefined => {
  try {
    const value = JSON.parse(raw) as unknown
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
    return value as Record<string, unknown>
  } catch {
    return undefined
  }
}

export { isUsageLimitError } from "@vibest/protocol/tools"

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
