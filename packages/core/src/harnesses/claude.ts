// Claude Code: vibest's plugin @vibest/claude (turn end, user prompt, pre-tool guard and the coordinator's inbox, all over
// vibestd's HTTP socket), loaded with
// `--plugin-dir` into each Claude vibest starts; its startup menus answered in the pane; models from its stream-json
// control requests.
import { Config, Effect, FileSystem, Path, Ref, Schema } from "effect"

import { anthropicOnly, type HarnessAdapter, opt, type Startup } from "../harness.ts"
import { findMessage, jsonLines, type RawModel, withConfigured } from "../models.ts"

// Claude's startup menus, answered like CAO does: Down until the accept option is under ❯, then Enter
// (the trust menu preselects "No, exit"). Claude has no flag or setting that skips the trust dialog.
const CLAUDE_MENUS = [
  { menu: "trust", pattern: /trust this folder/i, accept: /^\s*❯.*Yes, I trust this folder/im },
  { menu: "bypass", pattern: /bypass permissions/i, accept: /^\s*❯.*Yes, I accept/im },
]

/** The next key for a Claude menu on `screen` that is not answered yet. */
export const claudeMenuKey = (screen: string, answered: ReadonlyArray<string>) => {
  const m = CLAUDE_MENUS.find((m) => !answered.includes(m.menu) && m.pattern.test(screen))
  return m && { menu: m.menu, key: m.accept.test(screen) ? ("enter" as const) : ("down" as const) }
}

/** One key per tick; a menu counts as answered once Enter went in. */
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

/** Claude's built-in tools a Coordinator inspects with; its pre-tool hook (guard.ts) refuses edits and the other calls it names, the rest run. */
const CLAUDE_INSPECT_TOOLS = ["Bash", "Read", "Grep", "Glob", "Skill"]

/** Claude's permission rules that let `vibest report` run without asking, however vibest is invoked (`vibest`, `bun …/main.ts`). */
const vibestReport = (vibest: ReadonlyArray<string>) =>
  [...new Set(["vibest", vibest.join(" ")])].map((cmd) => `Bash(${cmd} report:*)`).join(",")

/**
 * The plugin's turn.complete report (`TurnComplete`) as a result: `answer` as it is;
 * `aborted` marked so (collectResult: a result only while vibest's round is open, so `vibest interrupt`'s own Esc is none);
 * `refusal` and `error` failed. turn.complete carries no API error kind, so `error` names no cause (no usage-limit move).
 */
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
  // The answer stays the result's text; repeating it here would print it twice.
  return { ...event, error: "error", error_details: "the turn ended on an API error" }
}

/** Where Claude keeps the transcript of session `id` started at `root`: every non-alphanumeric of the path becomes `-`. */
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
// An error answer has no `response`; it still ends the wait.
const claudeApplied = findMessage(
  Schema.Struct({
    type: Schema.Literal("control_response"),
    response: Schema.Struct({
      request_id: Schema.Literal("vibest-settings"),
      response: Schema.optional(Schema.Struct({ applied: Schema.optional(Schema.Struct({ model: optionalModel })) })),
    }),
  }),
)

/**
 * Claude: the stream-json `initialize` control request (what the Agent SDK's `supportedModels()` reads) for the list,
 * and `get_settings` for the model it would run (`applied.model`, after settings and env).
 * The list's own `default` entry is Anthropic's recommendation, not the user's setting, so it is dropped.
 */
export const claudeModels = (lines: ReadonlyArray<string>): ReadonlyArray<RawModel> | undefined => {
  const init = claudeInit(lines)
  const settings = claudeApplied(lines)
  if (!init || !settings) return undefined
  const models = init.response.response.models
  const applied = settings.response.response?.applied?.model ?? undefined
  return withConfigured(
    models
      .filter((m) => m.value !== "default")
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
    i.scratch,
    "--allowedTools",
    vibestReport(i.vibest),
    "--plugin-dir",
    i.pluginDir,
    // `claude --help`: --permission-mode plan is the read-only session mode.
    ...opt("--model", i.model),
  ],
  coordinatorArgs: (i) => [
    ...opt("--resume", i.sessionId),
    "--append-system-prompt-file",
    i.systemPromptFile,
    // No MCP servers, only the inspection tools; they run without a permission prompt, the pre-tool hook refuses what it names.
    "--strict-mcp-config",
    "--tools",
    CLAUDE_INSPECT_TOOLS.join(","),
    "--allowedTools",
    CLAUDE_INSPECT_TOOLS.join(","),
    "--plugin-dir",
    i.pluginDir,
    ...opt("--model", i.model),
  ],
  models: {
    // --safe-mode keeps hooks and plugins from running; --bare would skip OAuth and return a short list.
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
  // The plugin's prompt.submit: only what the person submitted, at the terminal (composer) or through Remote Control
  // (bridge); a task notification, a scheduled trigger, a peer or a plugin's prompt is not the person.
  userPrompt: (event, coordinator) => {
    if (coordinator || event.hook_event_name !== "PromptSubmit") return undefined
    if (event.origin !== "composer" && event.origin !== "bridge") return undefined
    return typeof event.text === "string" && event.text.trim() !== "" ? { text: event.text } : undefined
  },
  // The plugin's main-loop turn.complete, whatever its reason. The main agent's turn ends are no result.
  turnEnd: (event, coordinator) =>
    coordinator || event.hook_event_name !== "TurnComplete" ? undefined : { result: turnComplete(event) },
  // `--resume` of a session Claude never wrote fails (an id vibest chose up front before it took reported ones).
  canResume: (root, sessionId) =>
    Effect.flatMap(transcript(root, sessionId), (file) =>
      Effect.flatMap(FileSystem.FileSystem, (fs) => fs.exists(file)),
    ).pipe(Effect.orDie),
}
