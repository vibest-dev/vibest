// Claude Code: vibest's plugin @vibest/claude (turn end, pre-tool guard and the coordinator's inbox bridge), loaded with
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

const encodeClaudeSettings = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ permissions: Schema.Struct({ deny: Schema.Array(Schema.String) }) })),
)
/**
 * Every project's entries, not the scratchpads below them: Claude's deny wins over every allow, so the session's own
 * scratchpad can only stay reachable if scratch is left out here; the pre-tool hook (Guard.session) refuses the others.
 * Patterns follow gitignore (Claude's documented semantics): `//` anchors at the filesystem root, `**` spans the
 * repository key's levels (`github.com/owner/repo`, a hash, VIBEST_PROJECT_ID). A scratchpad directory named docs or
 * memory is denied too.
 */
const claudeSettings = (projectsDir: string) =>
  encodeClaudeSettings({
    permissions: {
      deny: [
        ...["instructions.md", "docs/**", "memory/**"].flatMap((p) => [
          `Read(/${projectsDir}/**/${p})`,
          `Edit(/${projectsDir}/**/${p})`,
        ]),
        "Bash(herdr:*)",
      ],
    },
  })

/** The turn-end events: Claude fires StopFailure instead of Stop when a turn ends on an API error. */
const TURN_END = ["Stop", "StopFailure"]

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
  rulesInPrompt: false,
  interruptKey: "esc",
  startup: claudeStartup,
  resultField: "last_assistant_message",
  inbox: "bridge",
  checkProvider: anthropicOnly("claude"),
  launchArgs: (i) => [
    ...(i.resume ? ["--resume", i.sessionId!] : ["--session-id", i.sessionId!]),
    "--append-system-prompt-file",
    i.rulesFile,
    "--add-dir",
    i.scratch,
    "--settings",
    claudeSettings(i.projectsDir),
    "--allowedTools",
    vibestReport(i.vibest),
    "--plugin-dir",
    i.pluginDir,
    // `claude --help`: --permission-mode plan is the read-only session mode.
    ...opt("--model", i.model),
  ],
  coordinatorArgs: (i) => [
    ...opt("--resume", i.sessionId),
    ...opt("--session-id", i.newSessionId ?? null),
    "--append-system-prompt-file",
    i.rulesFile,
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
  guardAnswer: (reason) =>
    reason
      ? {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: reason,
          },
        }
      : undefined,
  // classic.UserPromptSubmit. `source` is omitted while Claude rolls the field out; anything but `user` is not the person.
  userPrompt: (event, coordinator) => {
    if (coordinator || event.agent_id) return undefined
    if (event.hook_event_name !== "UserPromptSubmit" || typeof event.prompt !== "string" || event.prompt.trim() === "")
      return undefined
    if (typeof event.source === "string" && event.source !== "user") return undefined
    return { text: event.prompt }
  },
  // The @vibest/claude plugin's classic.Stop / classic.StopFailure; a subagent's turn end is not the session's.
  turnEnd: (event, coordinator) => {
    if (event.agent_id || typeof event.hook_event_name !== "string" || !TURN_END.includes(event.hook_event_name))
      return undefined
    if (!coordinator) return { result: event }
    return typeof event.session_id === "string" && event.session_id !== ""
      ? { harnessSessionId: event.session_id }
      : undefined
  },
  // `--resume` of a session Claude never wrote fails (an id vibest chose up front before it took reported ones).
  canResume: (root, sessionId) =>
    Effect.flatMap(transcript(root, sessionId), (file) =>
      Effect.flatMap(FileSystem.FileSystem, (fs) => fs.exists(file)),
    ).pipe(Effect.orDie),
}
