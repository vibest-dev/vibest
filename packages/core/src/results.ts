import type { HarnessId } from "./harness.ts"
import type { HarnessDefinition } from "./host.ts"

export const jsonObject = (raw: string): Record<string, unknown> | undefined => {
  try {
    const value = JSON.parse(raw) as unknown
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
    return value as Record<string, unknown>
  } catch {
    return undefined
  }
}

export const promptOf = (adapter: HarnessDefinition, agent: string, raw: string) => {
  const event = jsonObject(raw)
  const prompt = event && adapter.userPrompt?.(event, agent === "coordinator")
  return prompt?.text
}

export const isUsageLimitError = (error: string | undefined) => {
  const head = error?.split(":")[0]
  return head !== undefined && head !== "" && /rate[_ -]?limits?\b|usage limits?\b|too many requests/i.test(head)
}

export type ResultStatus = "completed" | "failed"

export interface Report {
  readonly summary: string | undefined
  readonly remember: string | undefined
}

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

export const outcome = (name: string, error: string | undefined) =>
  error ? `Agent "${name}" failed: ${error}` : `Agent "${name}" finished`

export type TurnEnded = {
  readonly harness: HarnessId
  readonly at: number
  readonly text: string
  readonly error: string | undefined
  readonly conversationId: string | undefined
  readonly interrupted: boolean
}

export const turnEndOf = (
  adapter: HarnessDefinition,
  agent: string,
  raw: string,
  at: number,
): TurnEnded | undefined => {
  const event = jsonObject(raw)
  const payload = event && adapter.turnEnd?.(event, agent === "coordinator")?.result
  return payload ? turnEndFrom(adapter, payload, at) : undefined
}

const PLAIN_ID_NOT_A_FLAG = /^\w[\w.:-]{0,127}$/
export const turnEndFrom = (
  adapter: HarnessDefinition,
  payload: Readonly<Record<string, unknown>>,
  at: number,
): TurnEnded => {
  const text = payload[adapter.resultField]
  const error = payload.error
  const details = payload.error_details
  const conversation = payload.conversation_id
  return {
    harness: adapter.id,
    at,
    text: typeof text === "string" ? text : "",
    error:
      typeof error === "string" && error
        ? typeof details === "string" && details
          ? `${error}: ${details}`
          : error
        : undefined,
    conversationId:
      typeof conversation === "string" && PLAIN_ID_NOT_A_FLAG.test(conversation) ? conversation : undefined,
    interrupted: payload.aborted === true,
  }
}
