import { Config, Effect, FileSystem, Path, Ref, Schema } from "effect"

import { anthropicOnly, type HarnessAdapter, opt, type Startup } from "../harness.ts"
import { findMessage, jsonLines, type RawModel, withConfigured } from "../models.ts"

const CLAUDE_MENUS = [
  { menu: "trust", pattern: /trust this folder/i, accept: /^\s*❯.*Yes, I trust this folder/im },
  { menu: "bypass", pattern: /bypass permissions/i, accept: /^\s*❯.*Yes, I accept/im },
]

export const claudeMenuKey = (screen: string, answered: ReadonlyArray<string>) => {
  const m = CLAUDE_MENUS.find((m) => !answered.includes(m.menu) && m.pattern.test(screen))
  return m && { menu: m.menu, key: m.accept.test(screen) ? ("enter" as const) : ("down" as const) }
}

const claudeStartup: Startup = Effect.map(
  Ref.make<ReadonlyArray<string>>([]),
  (answered) => (pane) =>
    Effect.gen(function* () {
      const next = claudeMenuKey(yield* pane.screen, yield* Ref.get(answered))
      if (!next) return
      if (next.key === "enter") yield* Ref.update(answered, (a) => [...a, next.menu])
      yield* pane.sendKeys([next.key])
    }),
)

const CLAUDE_INSPECT_TOOLS = ["Bash", "Read", "Grep", "Glob", "Skill"]

const projectDirRules = (dir: string) => [`Read(/${dir}/**)`, `Edit(/${dir}/**)`]

const vibestReport = (vibest: ReadonlyArray<string>) =>
  [...new Set(["vibest", vibest.join(" ")])].map((cmd) => `Bash(${cmd} report:*)`).join(",")

const turnComplete = (event: Readonly<Record<string, unknown>>) => {
  if (event.reason === "answer") return event
  if (event.reason === "aborted")
    return {
      ...event,
      aborted: true,
      error: "interrupted",
      error_details: "the turn was stopped in its terminal (Esc) before it ended",
    }
  if (event.reason === "refusal") {
    const r = (event.refusal ?? {}) as { readonly category?: unknown; readonly explanation?: unknown }
    const why = [r.category, r.explanation].filter((x) => typeof x === "string" && x !== "").join(": ")
    return { ...event, error: "refusal", error_details: why || "the model refused to answer" }
  }
  return { ...event, error: "error", error_details: "the turn ended on an API error" }
}

const transcript = Effect.fn("claudeTranscript")(function* (root: string, id: string) {
  const path = yield* Path.Path
  const dir = yield* Config.String("CLAUDE_CONFIG_DIR").pipe(
    Config.orElse(() => Config.String("HOME").pipe(Config.map((h) => path.join(h, ".claude")))),
  )
  return path.join(dir, "projects", root.replace(/[^a-zA-Z0-9]/g, "-"), `${id}.jsonl`)
})

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

export const claudeModels = (lines: ReadonlyArray<string>): ReadonlyArray<RawModel> | undefined => {
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

export const claude: HarnessAdapter = {
  id: "claude",
  binary: "claude",
  ownSessionId: true,
  systemPromptInPrompt: false,
  interruptKey: "esc",
  startup: claudeStartup,
  resultField: "last_assistant_message",
  inbox: "poll",
  ready: "integration",
  checkProvider: anthropicOnly("claude"),
  launchArgs: (i) => [
    ...(i.resume ? ["--resume", i.sessionId!] : ["--session-id", i.sessionId!]),
    "--append-system-prompt-file",
    i.systemPromptFile,
    "--add-dir",
    i.projectDir,
    "--allowedTools",
    [vibestReport(i.vibest), ...projectDirRules(i.projectDir)].join(","),
    "--plugin-dir",
    i.pluginDir,
    ...opt("--model", i.model),
  ],
  coordinatorArgs: (i) => [
    ...opt("--resume", i.sessionId),
    "--append-system-prompt-file",
    i.systemPromptFile,
    "--strict-mcp-config",
    "--tools",
    [...CLAUDE_INSPECT_TOOLS, "Edit", "Write"].join(","),
    "--add-dir",
    i.projectDir,
    "--allowedTools",
    [...CLAUDE_INSPECT_TOOLS, ...projectDirRules(i.projectDir)].join(","),
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
  userPrompt: (event, coordinator) => {
    if (coordinator || event.hook_event_name !== "PromptSubmit") return undefined
    if (event.origin !== "composer" && event.origin !== "bridge") return undefined
    return typeof event.text === "string" && event.text.trim() !== "" ? { text: event.text } : undefined
  },
  turnEnd: (event, coordinator) =>
    coordinator || event.hook_event_name !== "TurnComplete" ? undefined : { result: turnComplete(event) },
  canResume: (root, sessionId) =>
    Effect.flatMap(transcript(root, sessionId), (file) =>
      Effect.flatMap(FileSystem.FileSystem, (fs) => fs.exists(file)),
    ).pipe(Effect.orDie),
}
