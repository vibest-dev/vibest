import { assert, describe, it } from "@effect/vitest"
import type { Context, Harness } from "@vibest/plugin"
import { Effect } from "effect"

import { claude, claudeMenuKey, claudeModels } from "../src/claude.ts"
import { cursor, cursorModels } from "../src/cursor.ts"
import { claudePlugin, cursorPlugin, piPlugin } from "../src/index.ts"
import { pi, piModels } from "../src/pi.ts"

const ADAPTERS = { pi, claude, cursor }
const IDS = ["pi", "claude", "cursor"] as const
const hasNewline = (args: ReadonlyArray<string>) => args.some((a) => /[\r\n]/.test(a))

const launchInput: Harness.LaunchInput = {
  worktree: "/h/.vibest/worktrees/abcd1234-abcd-4abc-8abc-abcd1234abcd",
  projectDir: "/h/.vibest/projects/0f5a8b2c-1d3e-4f60-8a7b-9c0d1e2f3a4b",
  systemPromptFile: "/tmp/vibest/abcd1234-abcd-4abc-8abc-abcd1234abcd/system-prompt.md",
  provider: null,
  model: null,
  sessionId: "uuid-1",
  resume: false,
  pluginDir: "/opt/vibest/harnesses/x",
  vibest: ["/usr/bin/bun", "/src/main.ts"],
  env: {
    VIBEST_AGENT: "general",
    VIBEST_SESSION_ID: "abcd1234-abcd-4abc-8abc-abcd1234abcd",
    VIBEST_PROJECT_DIR: "/h/.vibest/projects/0f5a8b2c-1d3e-4f60-8a7b-9c0d1e2f3a4b",
  },
}

describe("HarnessAdapter", () => {
  const input = launchInput

  it("cursor resumes a dash-leading session id as one --resume= argument", () => {
    const dashLeadingArgs = ADAPTERS.cursor.launchArgs({
      ...input,
      resume: true,
      sessionId: "--yolo",
    })
    assert.strictEqual(dashLeadingArgs[0], "--resume=--yolo")
    assert.notInclude(dashLeadingArgs, "--yolo")
  })

  it("cursor reports its turn end at its response; its stop hook is not one", () => {
    const turnEnd = ADAPTERS.cursor.turnEnd!
    const reply = { hook_event_name: "afterAgentResponse", text: "done" }
    assert.deepStrictEqual(turnEnd(reply, false), { result: reply })
    for (const status of ["completed", "aborted", "error"])
      assert.isUndefined(turnEnd({ hook_event_name: "stop", status }, false))
    assert.isUndefined(turnEnd(reply, true))
  })

  it("claude reports every reason of the plugin's TurnComplete: answer as it is, aborted, refusal and error failed", () => {
    const turnEnd = ADAPTERS.claude.turnEnd!
    const answer = {
      hook_event_name: "TurnComplete",
      session_id: "c1",
      reason: "answer",
      last_assistant_message: "done",
    }
    assert.deepStrictEqual(turnEnd(answer, false), { result: answer })
    assert.isUndefined(turnEnd(answer, true))
    const aborted = { ...answer, reason: "aborted", last_assistant_message: "" }
    assert.deepStrictEqual(turnEnd(aborted, false), {
      result: {
        ...aborted,
        aborted: true,
        error: "interrupted",
        error_details: "the turn was stopped in its terminal (Esc) before it ended",
      },
    })
    assert.isUndefined(turnEnd(aborted, true))
    const error = { ...answer, reason: "error", last_assistant_message: "" }
    assert.deepStrictEqual(turnEnd(error, false), {
      result: { ...error, error: "error", error_details: "the turn ended on an API error" },
    })
    assert.deepStrictEqual(turnEnd({ ...error, last_assistant_message: " API Error: 500 " }, false), {
      result: {
        ...error,
        last_assistant_message: " API Error: 500 ",
        error: "error",
        error_details: "the turn ended on an API error",
      },
    })
    const refusal = { ...answer, reason: "refusal", refusal: { category: "cyber", explanation: "not that" } }
    assert.deepStrictEqual(turnEnd(refusal, false), {
      result: { ...refusal, error: "refusal", error_details: "cyber: not that" },
    })
    assert.deepStrictEqual(turnEnd({ ...refusal, refusal: { category: null, explanation: null } }, false), {
      result: {
        ...refusal,
        refusal: { category: null, explanation: null },
        error: "refusal",
        error_details: "the model refused to answer",
      },
    })
    for (const name of ["Stop", "StopFailure", "SubagentStop"])
      assert.isUndefined(turnEnd({ ...answer, hook_event_name: name }, false), name)
    assert.isUndefined(turnEnd({ ...answer, session_id: "" }, true))
  })

  it("claude reads a user prompt from the plugin's prompt.submit only when the person submitted it", () => {
    const userPrompt = ADAPTERS.claude.userPrompt!
    const typed = { hook_event_name: "PromptSubmit", text: "look here", origin: "composer" }
    assert.deepStrictEqual(userPrompt(typed, false), { text: "look here" })
    assert.deepStrictEqual(userPrompt({ ...typed, origin: "bridge" }, false), { text: "look here" })
    assert.isUndefined(userPrompt(typed, true))
    assert.isUndefined(userPrompt({ ...typed, text: "  " }, false))
    for (const origin of ["task-notification", "scheduled-trigger", "peer", "plugin", "sdk", "unclassified", undefined])
      assert.isUndefined(userPrompt({ ...typed, origin }, false), String(origin))
    assert.isUndefined(userPrompt({ hook_event_name: "UserPromptSubmit", prompt: "look here", source: "user" }, false))
  })

  it("cursor reads a user prompt from beforeSubmitPrompt, and a thought or tool result as a turn at work", () => {
    const userPrompt = ADAPTERS.cursor.userPrompt!
    const event = { hook_event_name: "beforeSubmitPrompt", prompt: "look here" }
    assert.deepStrictEqual(userPrompt(event, false), { text: "look here" })
    assert.isUndefined(userPrompt(event, true))
    assert.isUndefined(userPrompt({ hook_event_name: "beforeSubmitPrompt", prompt: "  " }, false))
    assert.isUndefined(userPrompt({ hook_event_name: "afterAgentResponse", prompt: "look here" }, false))
    for (const hook_event_name of ["afterAgentThought", "postToolUse"]) {
      assert.deepStrictEqual(userPrompt({ hook_event_name }, false), { text: "" })
      assert.isUndefined(userPrompt({ hook_event_name }, true))
    }
  })

  it("Coordinator argv: rules, the inspection tools and file tools for the project folder, no MCP server at all; cursor cannot be one", () => {
    const input: Harness.CoordinatorInput = {
      root: "/repo",
      projectDir: "/h/p",
      systemPromptFile: "/tmp/vibest/c0ffee00-c0ff-4c0f-8c0f-c0ffee00c0ff/system-prompt.md",
      provider: null,
      model: "m",
      sessionId: null,
      pluginDir: "/opt/vibest/harnesses/x",
      env: { VIBEST_AGENT: "coordinator", HERDR_PANE_ID: "w1:p1" },
    }
    const claude = ADAPTERS.claude.coordinatorArgs!(input)
    assert.deepStrictEqual(
      claude.slice(claude.indexOf("--strict-mcp-config"), claude.indexOf("--strict-mcp-config") + 7),
      [
        "--strict-mcp-config",
        "--tools",
        "Bash,Read,Grep,Glob,Skill,Edit,Write",
        "--add-dir",
        "/h/p",
        "--allowedTools",
        "Bash,Read,Grep,Glob,Skill,Read(//h/p/**),Edit(//h/p/**)",
      ],
    )
    assert.notInclude(claude, "--mcp-config")
    assert.include(claude, "--append-system-prompt-file")
    assert.deepStrictEqual(ADAPTERS.pi.coordinatorArgs!(input), [
      "--system-prompt",
      input.systemPromptFile,
      "--tools",
      "read,bash,codemode,grep,find,ls,write,edit",
      "--no-mcp",
      "-e",
      `${input.pluginDir}/extension.mjs`,
      "--model",
      "m",
    ])
    assert.isUndefined(ADAPTERS.cursor.coordinatorArgs)
    assert.deepStrictEqual(ADAPTERS.pi.coordinatorArgs!({ ...input, sessionId: "s" }).slice(0, 2), [
      "--session-id",
      "s",
    ])
    assert.deepStrictEqual(ADAPTERS.claude.coordinatorArgs!({ ...input, sessionId: "s" }).slice(0, 2), [
      "--resume",
      "s",
    ])
    for (const id of ["pi", "claude"] as const)
      assert.notInclude(ADAPTERS[id].coordinatorArgs!(input).join(" "), "session")
    for (const id of IDS)
      if (ADAPTERS[id].coordinatorArgs) assert.isFalse(hasNewline(ADAPTERS[id].coordinatorArgs!(input)))
  })

  it("Sessions get no vibest MCP server: claude may run vibest send, and read and edit in the project folder", () => {
    for (const id of IDS)
      assert.isEmpty(
        ADAPTERS[id].launchArgs(input).filter((a) => /mcp/i.test(a)),
        id,
      )
    const claude = ADAPTERS.claude.launchArgs(input)
    assert.strictEqual(
      claude[claude.indexOf("--allowedTools") + 1],
      `Bash(vibest send:*),Bash(/usr/bin/bun /src/main.ts send:*),Read(/${input.projectDir}/**),Edit(/${input.projectDir}/**)`,
    )
    assert.strictEqual(claude[claude.indexOf("--add-dir") + 1], input.projectDir)
  })
})

describe("harness output", () => {
  it("claude startup menus: Down until the accept option is under ❯, then Enter, once", () => {
    const trustDialog = "Do you trust the files in this folder?\n\n ❯ 1. No, exit\n   2. Yes, I trust this folder\n"
    const moved = "Do you trust the files in this folder?\n\n   1. No, exit\n ❯ 2. Yes, I trust this folder\n"
    assert.deepStrictEqual(claudeMenuKey(trustDialog, []), { menu: "trust", key: "down" })
    assert.deepStrictEqual(claudeMenuKey(moved, []), { menu: "trust", key: "enter" })
    assert.strictEqual(claudeMenuKey(moved, ["trust"]), undefined)
    assert.strictEqual(claudeMenuKey("❯ ready", []), undefined)
  })

  it("model lists: each harness's own output, its run-without-model choice marked default", () => {
    const j = (v: unknown) => JSON.stringify(v)
    const claudeList = j({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "vibest-models",
        response: {
          models: [
            {
              value: "default",
              resolvedModel: "claude-opus-5-5",
              displayName: "Default (recommended)",
              description: "Opus 5.5",
            },
            { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5", description: "complex work" },
            { value: "sonnet", resolvedModel: "claude-sonnet-5-5", displayName: "Sonnet 5.5", description: "routine" },
          ],
        },
      },
    })
    const claudeApplied = (model: string) =>
      j({
        type: "control_response",
        response: { subtype: "success", request_id: "vibest-settings", response: { applied: { model } } },
      })
    const hook = j({ type: "system", subtype: "hook_started" })
    assert.deepStrictEqual(claudeModels([hook, claudeList, claudeApplied("claude-sonnet-5-5")]), [
      { model: "opus", name: "Opus 5.5", description: "complex work", default: false },
      { model: "sonnet", name: "Sonnet 5.5", description: "routine", default: true },
    ])
    assert.deepStrictEqual(claudeModels([claudeList, claudeApplied("grok-4.6")])?.at(-1), {
      model: "grok-4.6",
      default: true,
    })
    assert.isUndefined(claudeModels([hook, claudeList]))

    const piList = j({
      id: "vibest-models",
      type: "response",
      command: "get_available_models",
      success: true,
      data: {
        models: [
          { provider: "xai", id: "grok-4.3", name: "Grok 4.3", contextWindow: 1000000, maxTokens: 30000, cost: {} },
          { provider: "zai", id: "glm-5.3", name: "GLM 5.3", contextWindow: 272000, maxTokens: 16384 },
        ],
      },
    })
    const piState = j({
      id: "vibest-state",
      type: "response",
      command: "get_state",
      success: true,
      data: { model: { provider: "zai", id: "glm-5.3", name: "GLM 5.3" } },
    })
    assert.deepStrictEqual(piModels([j({ type: "extension_ui_request" }), piState, piList]), [
      {
        provider: "xai",
        model: "grok-4.3",
        name: "Grok 4.3",
        description: "1000000 context, 30000 max output tokens",
        default: false,
      },
      {
        provider: "zai",
        model: "glm-5.3",
        name: "GLM 5.3",
        description: "272000 context, 16384 max output tokens",
        default: true,
      },
    ])
    assert.isUndefined(piModels([piList]))

    const cursor = [
      "Available models",
      "",
      "auto - Auto (default)",
      "composer-2.5 - Composer 2.5 (current)",
      "glm-5.2-max - GLM 5.2 Max",
      "",
      "Tip: use --model <id> (or /model <id> in interactive mode) to switch.",
    ]
    assert.deepStrictEqual(cursorModels(cursor), [
      { model: "auto", name: "Auto", default: false },
      { model: "composer-2.5", name: "Composer 2.5", default: true },
      { model: "glm-5.2-max", name: "GLM 5.2 Max", default: false },
    ])
    assert.isUndefined(cursorModels(["Not logged in"]))
  })
})

describe("plugins", () => {
  it.effect("each builtin harness plugin adds one definition under its id", () =>
    Effect.gen(function* () {
      for (const [plugin, definition] of [
        [piPlugin, pi],
        [claudePlugin, claude],
        [cursorPlugin, cursor],
      ] as const) {
        const added: Array<Harness.HarnessDefinition> = []
        const editor = { add: (d: Harness.HarnessDefinition) => void added.push(d) }
        const context = {
          harness: {
            transform: (f: (e: typeof editor) => void) => Effect.sync(() => (f(editor), { dispose: Effect.void })),
          },
        } as unknown as Context
        yield* plugin.effect(context)
        assert.strictEqual(plugin.id, `harness-${definition.id}`)
        assert.deepStrictEqual(added, [definition])
      }
    }).pipe(Effect.scoped),
  )
})
