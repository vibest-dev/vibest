import type { Harness } from "@vibest/plugin/effect"
import { Schema } from "effect"

import { findMessage, jsonLines, opt, withConfigured } from "./models.ts"

const extensions = (pluginDir: string) => ["-e", `${pluginDir}/extension.mjs`, "-e", `${pluginDir}/presentation.mjs`]

const piState = findMessage(
  Schema.Struct({
    id: Schema.Literal("vibest-state"),
    type: Schema.Literal("response"),
    data: Schema.optional(
      Schema.Struct({
        model: Schema.optional(Schema.NullOr(Schema.Struct({ provider: Schema.String, id: Schema.String }))),
      }),
    ),
  }),
)
const piList = findMessage(
  Schema.Struct({
    id: Schema.Literal("vibest-models"),
    type: Schema.Literal("response"),
    data: Schema.Struct({
      models: Schema.Array(
        Schema.Struct({
          provider: Schema.String,
          id: Schema.String,
          name: Schema.String,
          contextWindow: Schema.Number,
          maxTokens: Schema.Number,
        }),
      ),
    }),
  }),
)

export const piModels = (lines: ReadonlyArray<string>): ReadonlyArray<Harness.RawModel> | undefined => {
  const state = piState(lines)
  const list = piList(lines)
  if (!state || !list) return undefined
  const current = state.data?.model ?? undefined
  return withConfigured(
    list.data.models.map((m) => ({
      provider: m.provider,
      model: m.id,
      name: m.name,
      description: `${m.contextWindow} context, ${m.maxTokens} max output tokens`,
      default: m.provider === current?.provider && m.id === current.id,
    })),
    current && { provider: current.provider, model: current.id },
  )
}

const providerModel = (provider: string | null, model: string | null) =>
  model ? [...opt("--provider", provider), "--model", model] : []

const VIBEST_DELIVERY_SOURCE = "extension"

export const pi: Harness.HarnessDefinition = {
  id: "pi",
  binary: "pi",
  ownSessionId: true,
  systemPromptInPrompt: false,
  interruptKey: "esc",
  replyField: "text",
  inbox: "subscribe",
  ready: "integration",
  checkProvider: () => undefined,
  launchArgs: (i) => [
    ...opt("--session-id", i.sessionId),
    "--append-system-prompt",
    i.systemPromptFile,
    ...extensions(i.pluginDir),
    ...providerModel(i.provider, i.model),
  ],
  models: {
    args: () => ["--mode", "rpc", "--no-session"],
    request: jsonLines(
      { id: "vibest-state", type: "get_state" },
      { id: "vibest-models", type: "get_available_models" },
    ),
    answer: piModels,
  },
  userPrompt: (event) => {
    if (event.type === "accepted")
      return typeof event.execution === "number" ? { execution: event.execution } : undefined
    if (event.source === VIBEST_DELIVERY_SOURCE || event.type !== "input") return undefined
    if (typeof event.text !== "string" || event.text.trim() === "") return undefined
    return { text: event.text }
  },
  executionEnd: (event) => {
    if (event.type !== "agent_settled") return undefined
    const aborted = event.aborted === true
    const error = typeof event.error === "string" ? event.error : ""
    return {
      end: {
        text: typeof event.text === "string" ? event.text : "",
        error: error || (aborted ? "aborted" : ""),
        aborted,
      },
    }
  },
}
