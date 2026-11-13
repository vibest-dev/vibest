import { assert, describe, it } from "@effect/vitest"
import type { Harness } from "@vibest/plugin"

import { claude, claudeMenuKey, claudeModels } from "../src/claude.ts"
import { cursor, cursorModels } from "../src/cursor.ts"
import { pi, piModels } from "../src/pi.ts"

const ADAPTERS = { pi, claude, cursor }

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

  it("cursor reports its execution end at its response; its stop hook is not one", () => {
    const executionEnd = ADAPTERS.cursor.executionEnd!
    const reply = { hook_event_name: "afterAgentResponse", text: "done" }
    assert.deepStrictEqual(executionEnd(reply), { end: reply })
    for (const status of ["completed", "aborted", "error"])
      assert.isUndefined(executionEnd({ hook_event_name: "stop", status }))
  })

  it("claude reports every reason of the plugin's ExecutionComplete: answer as it is, aborted, refusal and error failed", () => {
    const executionEnd = ADAPTERS.claude.executionEnd!
    const answer = {
      hook_event_name: "ExecutionComplete",
      session_id: "c1",
      reason: "answer",
      last_assistant_message: "done",
    }
    assert.deepStrictEqual(executionEnd(answer), { end: answer })
    const aborted = { ...answer, reason: "aborted", last_assistant_message: "" }
    assert.deepStrictEqual(executionEnd(aborted), {
      end: {
        ...aborted,
        aborted: true,
        error: "interrupted",
        error_details: "the execution was stopped in its terminal (Esc) before it ended",
      },
    })
    const error = { ...answer, reason: "error", last_assistant_message: "" }
    assert.deepStrictEqual(executionEnd(error), {
      end: { ...error, error: "error", error_details: "the execution ended on an API error" },
    })
    assert.deepStrictEqual(executionEnd({ ...error, last_assistant_message: " API Error: 500 " }), {
      end: {
        ...error,
        last_assistant_message: " API Error: 500 ",
        error: "error",
        error_details: "the execution ended on an API error",
      },
    })
    const refusal = { ...answer, reason: "refusal", refusal: { category: "cyber", explanation: "not that" } }
    assert.deepStrictEqual(executionEnd(refusal), {
      end: { ...refusal, error: "refusal", error_details: "cyber: not that" },
    })
    assert.deepStrictEqual(executionEnd({ ...refusal, refusal: { category: null, explanation: null } }), {
      end: {
        ...refusal,
        refusal: { category: null, explanation: null },
        error: "refusal",
        error_details: "the model refused to answer",
      },
    })
    for (const name of ["Stop", "StopFailure", "SubagentStop"])
      assert.isUndefined(executionEnd({ ...answer, hook_event_name: name }), name)
  })

  it("claude reads a user prompt from the plugin's prompt.submit only when the person submitted it", () => {
    const userPrompt = ADAPTERS.claude.userPrompt!
    const typed = { hook_event_name: "PromptSubmit", text: "look here", origin: "composer" }
    assert.deepStrictEqual(userPrompt(typed), { text: "look here" })
    assert.deepStrictEqual(userPrompt({ ...typed, origin: "bridge" }), { text: "look here" })
    assert.isUndefined(userPrompt({ ...typed, text: "  " }))
    for (const origin of ["task-notification", "scheduled-trigger", "peer", "plugin", "sdk", "unclassified", undefined])
      assert.isUndefined(userPrompt({ ...typed, origin }), String(origin))
    assert.isUndefined(userPrompt({ hook_event_name: "UserPromptSubmit", prompt: "look here", source: "user" }))
  })

  it("claude and pi read the report of a taken batch as the execution it started, not as a typed prompt", () => {
    assert.deepStrictEqual(
      ADAPTERS.claude.userPrompt!({ hook_event_name: "PromptSubmit", origin: "vibest", execution: 7 }),
      { execution: 7 },
    )
    assert.isUndefined(ADAPTERS.claude.userPrompt!({ hook_event_name: "PromptSubmit", origin: "vibest" }))
    assert.deepStrictEqual(ADAPTERS.pi.userPrompt!({ type: "accepted", execution: 7 }), { execution: 7 })
    assert.isUndefined(ADAPTERS.pi.userPrompt!({ type: "accepted" }))
  })

  it("cursor reads a user prompt from beforeSubmitPrompt, and a thought or tool result as an execution at work", () => {
    const userPrompt = ADAPTERS.cursor.userPrompt!
    const event = { hook_event_name: "beforeSubmitPrompt", prompt: "look here" }
    assert.deepStrictEqual(userPrompt(event), { text: "look here" })
    assert.isUndefined(userPrompt({ hook_event_name: "beforeSubmitPrompt", prompt: "  " }))
    assert.isUndefined(userPrompt({ hook_event_name: "afterAgentResponse", prompt: "look here" }))
    for (const hook_event_name of ["afterAgentThought", "postToolUse"]) {
      assert.deepStrictEqual(userPrompt({ hook_event_name }), { text: "" })
    }
  })

  it("an entry session with no conversation yet starts without a session id or resume flag", () => {
    for (const id of ["claude", "pi"] as const)
      assert.notInclude(ADAPTERS[id].launchArgs({ ...input, sessionId: null }).join(" "), "session")
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
