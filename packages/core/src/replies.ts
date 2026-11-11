import { ENTRY_AGENT } from "./db-rows.ts"
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
  const prompt = event && adapter.userPrompt?.(event, agent === ENTRY_AGENT)
  return prompt?.text
}

export const isUsageLimitError = (error: string | undefined) => {
  const head = error?.split(":")[0]
  return head !== undefined && head !== "" && /rate[_ -]?limits?\b|usage limits?\b|too many requests/i.test(head)
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

export type ObservedEnd = {
  readonly harness: HarnessId
  readonly at: number
  readonly status: "completed" | "failed" | "interrupted"
  readonly reply: string
  readonly failure: string | undefined
  readonly limited: boolean
  readonly conversation: string | undefined
  readonly needsReady: boolean
}

export const executionEndOf = (
  adapter: HarnessDefinition,
  agent: string,
  raw: string,
  at: number,
): ObservedEnd | undefined => {
  const event = jsonObject(raw)
  const payload = event && adapter.executionEnd?.(event, agent === ENTRY_AGENT)?.end
  return payload ? executionEndFrom(adapter, payload, at) : undefined
}

const PLAIN_ID_NOT_A_FLAG = /^\w[\w.:-]{0,127}$/
const errorOf = (payload: Readonly<Record<string, unknown>>) => {
  const error = payload.error
  const details = payload.error_details
  if (typeof error !== "string" || !error) return undefined
  return typeof details === "string" && details ? `${error}: ${details}` : error
}

export const executionEndFrom = (
  adapter: HarnessDefinition,
  payload: Readonly<Record<string, unknown>>,
  at: number,
): ObservedEnd => {
  const text = payload[adapter.replyField]
  const conversation = payload.conversation_id
  const interrupted = payload.aborted === true
  const error = interrupted ? undefined : errorOf(payload)
  return {
    harness: adapter.id,
    at,
    status: interrupted ? "interrupted" : error ? "failed" : "completed",
    reply: typeof text === "string" ? text : "",
    failure: error,
    limited: isUsageLimitError(error),
    conversation:
      !adapter.ownSessionId && typeof conversation === "string" && PLAIN_ID_NOT_A_FLAG.test(conversation)
        ? conversation
        : undefined,
    needsReady: adapter.ready === "integration",
  }
}
