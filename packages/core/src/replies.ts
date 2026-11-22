import type { Sender } from "@vibest/schema/event"
import type { Detail, HarnessId } from "@vibest/schema/session"
import { Option, Predicate, Schema } from "effect"

import type { HarnessDefinition } from "./plugin/domains.ts"

const decodeJsonObject = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)))

export const jsonObject = (raw: string) => Option.getOrUndefined(decodeJsonObject(raw))

export const guardInputOf = (adapter: HarnessDefinition, raw: string) => {
  if (adapter.guardCall === undefined) return raw
  const event = jsonObject(raw)

  if (event === undefined) return raw
  const call = adapter.guardCall(event)

  return call === undefined ? undefined : JSON.stringify(call)
}

export const promptOf = (adapter: HarnessDefinition, raw: string) => {
  const event = jsonObject(raw)

  return event && adapter.userPrompt?.(event)
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
    ...fields.flatMap(([k, v]) => (v === "" ? [] : [`<${k}>${escapeText(v)}</${k}>`])),
    `<${text[0]}>`,
    text[1],
    `</${text[0]}>`,
    `</${tag}>`,
  ].join("\n")

export const sessionEnvelope = (id: string, message: string) =>
  envelope("vibest-agent-message", [["agent-id", id]], ["message", message])

export const noticeEnvelope = (message: string) => envelope("vibest-message", [], ["message", message])

export const envelopeFrom = (sender: Sender, message: string) => {
  switch (sender.type) {
    case "user":
      return message
    case "vibest":
      return noticeEnvelope(message)
    case "plugin":
      return envelope("vibest-message", [["plugin", sender.plugin]], ["message", message])
    case "agent":
      return sessionEnvelope(sender.session, message)
  }
}

const ENVELOPED =
  /^<(vibest-agent-message|vibest-message)>\n(?:<[a-z-]+>[^\n]*<\/[a-z-]+>\n)*<message>\n([\s\S]*)\n<\/message>\n<\/\1>$/

export const unwrapped = (rendered: string) => ENVELOPED.exec(rendered)?.[2] ?? rendered

type Delivered = {
  readonly kind: string
  readonly sender: Sender
  readonly message: string
}

export const detailOf = (batch: ReadonlyArray<Delivered>): ReadonlyArray<Detail> =>
  batch.map((row) => ({
    sender: row.sender,
    message: row.sender.type === "user" ? row.message : unwrapped(row.message),
  }))

export type ObservedEnd = {
  readonly harness: HarnessId
  readonly at: number
  readonly status: "completed" | "failed" | "interrupted"
  readonly reply: string
  readonly failure: string | undefined
  readonly limited: boolean
  readonly resetAt?: number | undefined
  readonly provider?: string | undefined
  readonly windows?: ReadonlyArray<string> | undefined
  readonly conversation: string | undefined
  readonly needsReady: boolean
  readonly execution?: number | undefined
}

export const executionEndOf = (adapter: HarnessDefinition, raw: string, at: number): ObservedEnd | undefined => {
  const event = jsonObject(raw)
  const payload = event && adapter.executionEnd?.(event)?.end

  return payload ? executionEndFrom(adapter, payload, at) : undefined
}

const PLAIN_ID_NOT_A_FLAG = /^\w[\w.:-]{0,127}$/

const errorOf = (payload: Schema.JsonObject) => {
  const error = payload.error
  const details = payload.error_details

  if (!Predicate.isString(error) || !error) return undefined

  return Predicate.isString(details) && details ? `${error}: ${details}` : error
}

export const executionEndFrom = (adapter: HarnessDefinition, payload: Schema.JsonObject, at: number): ObservedEnd => {
  const text = payload[adapter.replyField]
  const conversation = payload.conversation_id
  const interrupted = payload.aborted === true
  const error = interrupted ? undefined : errorOf(payload)

  return {
    harness: adapter.id,
    at,
    status: interrupted ? "interrupted" : error ? "failed" : "completed",
    reply: Predicate.isString(text) ? text : "",
    failure: error,
    limited: isUsageLimitError(error),
    conversation:
      !adapter.ownSessionId && Predicate.isString(conversation) && PLAIN_ID_NOT_A_FLAG.test(conversation)
        ? conversation
        : undefined,
    needsReady: adapter.ready === "integration",
    ...(Predicate.isNumber(payload.execution) && { execution: payload.execution }),
  }
}
