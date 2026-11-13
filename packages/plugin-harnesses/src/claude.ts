import type { Harness } from "@vibest/plugin"
import { Effect, Ref, Schema } from "effect"

import { findMessage, jsonLines, noProvider, opt, withConfigured } from "./models.ts"

const CLAUDE_MENUS = [
  { menu: "trust", pattern: /trust this folder/i, accept: /^\s*❯.*Yes, I trust this folder/im },
  { menu: "bypass", pattern: /bypass permissions/i, accept: /^\s*❯.*Yes, I accept/im },
]

export const claudeMenuKey = (screen: string, answered: ReadonlyArray<string>) => {
  const m = CLAUDE_MENUS.find((m) => !answered.includes(m.menu) && m.pattern.test(screen))
  return m && { menu: m.menu, key: m.accept.test(screen) ? ("enter" as const) : ("down" as const) }
}

const claudeStartup: NonNullable<Harness.HarnessDefinition["startup"]> = Effect.map(
  Ref.make<ReadonlyArray<string>>([]),
  (answered) => (pane) =>
    Effect.gen(function* () {
      const next = claudeMenuKey(yield* pane.screen, yield* Ref.get(answered))
      if (!next) return
      if (next.key === "enter") yield* Ref.update(answered, (a) => [...a, next.menu])
      yield* pane.sendKeys([next.key])
    }),
)

const projectDirRules = (dir: string) => [`Read(/${dir}/**)`, `Edit(/${dir}/**)`]

const executionComplete = (event: Readonly<Record<string, unknown>>) => {
  if (event.reason === "answer") return event
  if (event.reason === "aborted")
    return {
      ...event,
      aborted: true,
      error: "interrupted",
      error_details: "the execution was stopped in its terminal (Esc) before it ended",
    }
  if (event.reason === "refusal") {
    const r = (event.refusal ?? {}) as { readonly category?: unknown; readonly explanation?: unknown }
    const why = [r.category, r.explanation].filter((x) => typeof x === "string" && x !== "").join(": ")
    return { ...event, error: "refusal", error_details: why || "the model refused to answer" }
  }
  return { ...event, error: "error", error_details: "the execution ended on an API error" }
}

const optionalModel = Schema.optional(Schema.NullOr(Schema.String))

const claudeInit = findMessage(
  Schema.Struct({
    type: Schema.Literal("control_response"),
    response: Schema.Struct({
      request_id: Schema.Literal("vibest-models"),
      response: Schema.Struct({
        models: Schema.Array(
          Schema.Struct({
            value: Schema.String,
            resolvedModel: Schema.optional(Schema.String),
            displayName: Schema.String,
            description: Schema.String,
          }),
        ),
      }),
    }),
  }),
)
const claudeApplied = findMessage(
  Schema.Struct({
    type: Schema.Literal("control_response"),
    response: Schema.Struct({
      request_id: Schema.Literal("vibest-settings"),
      response: Schema.optional(Schema.Struct({ applied: Schema.optional(Schema.Struct({ model: optionalModel })) })),
    }),
  }),
)

const ANTHROPIC_RECOMMENDED_ENTRY = "default"

export const claudeModels = (lines: ReadonlyArray<string>): ReadonlyArray<Harness.RawModel> | undefined => {
  const init = claudeInit(lines)
  const settings = claudeApplied(lines)
  if (!init || !settings) return undefined
  const models = init.response.response.models
  const applied = settings.response.response?.applied?.model ?? undefined
  return withConfigured(
    models
      .filter((m) => m.value !== ANTHROPIC_RECOMMENDED_ENTRY)
      .map((m) => ({
        model: m.value,
        name: m.displayName,
        description: m.description,
        default: applied !== undefined && (m.resolvedModel ?? m.value) === applied,
      })),
    applied ? { model: applied } : undefined,
  )
}

export const claude: Harness.HarnessDefinition = {
  id: "claude",
  binary: "claude",
  ownSessionId: true,
  systemPromptInPrompt: false,
  interruptKey: "esc",
  startup: claudeStartup,
  replyField: "last_assistant_message",
  inbox: "poll",
  ready: "integration",
  checkProvider: noProvider("claude"),
  launchArgs: (i) => [
    ...(i.sessionId === null ? [] : [i.resume ? "--resume" : "--session-id", i.sessionId]),
    "--append-system-prompt-file",
    i.systemPromptFile,
    "--add-dir",
    i.projectDir,
    "--allowedTools",
    ["Bash", ...projectDirRules(i.projectDir)].join(","),
    "--plugin-dir",
    i.pluginDir,
    ...opt("--model", i.model),
  ],
  models: {
    args: () => [
      "-p",
      "--safe-mode",
      "--no-session-persistence",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
    ],
    request: jsonLines(
      { type: "control_request", request_id: "vibest-models", request: { subtype: "initialize" } },
      { type: "control_request", request_id: "vibest-settings", request: { subtype: "get_settings" } },
    ),
    answer: claudeModels,
  },
  userPrompt: (event) => {
    if (event.hook_event_name !== "PromptSubmit") return undefined
    if (event.origin === "vibest")
      return typeof event.execution === "number"
        ? { execution: event.execution, ...(event.refused === true ? { refused: true as const } : {}) }
        : undefined
    if (event.origin !== "composer" && event.origin !== "bridge") return undefined
    return typeof event.text === "string" && event.text.trim() !== "" ? { text: event.text } : undefined
  },
  executionEnd: (event) =>
    event.hook_event_name !== "ExecutionComplete" ? undefined : { end: executionComplete(event) },
}
