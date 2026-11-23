import type { Sender } from "@vibest/schema/event"
import type { Detail, HarnessId } from "@vibest/schema/session"
import { Option, Schema } from "effect"

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
  envelope("vibest-agent-message", [["session-id", id]], ["message", message])

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
  readonly pulls?: boolean | undefined
  readonly execution?: number | undefined
}

export const executionEndOf = (adapter: HarnessDefinition, raw: string, at: number): ObservedEnd | undefined => {
  const event = jsonObject(raw)
  const observed = event && adapter.executionEnd?.(event)

  return observed ? executionEndFrom(adapter, observed, at) : undefined
}

const PLAIN_ID_NOT_A_FLAG = /^\w[\w.:-]{0,127}$/

export const executionEndFrom = (
  adapter: HarnessDefinition,
  observed: {
    readonly reply: string
    readonly failure?: string
    readonly interrupted?: boolean
    readonly conversation?: string
    readonly execution?: number
  },
  at: number,
): ObservedEnd => {
  const failure = observed.interrupted ? undefined : observed.failure
  const conversation = observed.conversation

  return {
    harness: adapter.id,
    at,
    status: observed.interrupted ? "interrupted" : failure ? "failed" : "completed",
    reply: observed.reply,
    failure,
    limited: isUsageLimitError(failure),
    conversation: conversation !== undefined && PLAIN_ID_NOT_A_FLAG.test(conversation) ? conversation : undefined,
    needsReady: adapter.ready === "integration",
    pulls: adapter.delivery === "pull",
    ...(observed.execution !== undefined && { execution: observed.execution }),
  }
}
