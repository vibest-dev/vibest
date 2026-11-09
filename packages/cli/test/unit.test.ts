import { assert, describe, it } from "@effect/vitest"
import { type CoordinatorInput, HARNESS_IDS, hasNewline, type LaunchInput } from "@vibest/core/harness"
import { BUILTIN as ADAPTERS } from "@vibest/core/harnesses"
import { claudeMenuKey, claudeModels } from "@vibest/core/harnesses/claude"
import { cursorModels } from "@vibest/core/harnesses/cursor"
import { piModels } from "@vibest/core/harnesses/pi"
import { normalizeModels } from "@vibest/core/models"
import { Layout, shellQuote } from "@vibest/core/paths"
import { envelope, isUsageLimitError, outcome, parseReport } from "@vibest/core/results"
import { privateTmp, UserPlatform } from "@vibest/core/system-prompt"
import { ID, newId, shortId } from "@vibest/schema/id"
import { Cause, ConfigProvider, Effect, Exit, FileSystem } from "effect"

import * as Platform from "#platform"

import { tempDirectory } from "./fakes.ts"

describe("ids", () => {
  it.effect("a new id is a UUIDv4; one whose first 8 characters are taken is drawn again", () =>
    Effect.gen(function* () {
      assert.match(yield* newId(), ID)
      const asked: Array<string> = []
      const id = yield* newId((short) => Effect.sync(() => asked.push(short) < 3))
      assert.match(id, ID)
      assert.lengthOf(asked, 3)
      assert.strictEqual(shortId(id), asked[2])
      assert.strictEqual(shortId(id).length, 8)
    }),
  )
})

describe("System prompt directory", () => {
  const refused = <A, E, R>(e: Effect.Effect<A, E, R>) =>
    e.pipe(
      Effect.exit,
      Effect.map((exit) => {
        assert.isTrue(Exit.isFailure(exit))
        assert.match(String(Exit.isFailure(exit) && Cause.pretty(exit.cause)), /not a private directory/)
      }),
    )

  it.effect(
    "under TMPDIR: <TMPDIR>/vibest, made 0700; no TMPDIR: <parent>/vibest-<uid>, made 0700 and used again; a wrong mode, a symlink or another owner is refused",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const tmp = yield* tempDirectory("vibest-tmpdir-")
        assert.strictEqual(yield* privateTmp(tmp, "/nowhere"), `${tmp}/vibest`)
        assert.strictEqual((yield* fs.stat(`${tmp}/vibest`)).mode & 0o777, 0o700)
        const user = yield* UserPlatform
        const uid = user.uid!
        const parent = yield* tempDirectory("vibest-fallback-")
        const dir = `${parent}/vibest-${uid}`
        assert.strictEqual(yield* privateTmp("", parent), dir)
        assert.strictEqual((yield* fs.stat(dir)).mode & 0o777, 0o700)
        assert.strictEqual(yield* privateTmp("", parent), dir, "an existing private directory is used again")

        yield* fs.chmod(dir, 0o755)
        yield* refused(privateTmp("", parent))

        yield* fs.remove(dir, { recursive: true })
        const target = `${parent}/elsewhere`
        yield* fs.makeDirectory(target, { mode: 0o700 })
        yield* fs.symlink(target, dir)
        yield* refused(privateTmp("", parent))

        yield* fs.remove(dir)
        const asAnotherUid = { ...user, uid: uid + 1 }
        yield* refused(privateTmp("", parent).pipe(Effect.provideService(UserPlatform, asAnotherUid)))
      }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )
})

describe("envelope", () => {
  it("one element per field, empty ones left out, field text escaped and the agent's text kept as is", () => {
    assert.strictEqual(
      envelope(
        "agent-result",
        [
          ["agent-id", "a1b2c3d4-a1b2-4a1b-8a1b-a1b2c3d4a1b2"],
          ["summary", outcome('fix "x" <y>', undefined)],
          ["branch", ""],
        ],
        ["result", "a <b> & c"],
      ),
      '<agent-result>\n<agent-id>a1b2c3d4-a1b2-4a1b-8a1b-a1b2c3d4a1b2</agent-id>\n<summary>Agent "fix "x" &lt;y&gt;" finished</summary>\n<result>\na <b> & c\n</result>\n</agent-result>',
    )
    assert.strictEqual(outcome("t", "rate_limit"), 'Agent "t" failed: rate_limit')
    assert.isTrue(isUsageLimitError("rate_limit"))
    assert.isTrue(isUsageLimitError("rate_limit: hit the 5 hour limit"))
    assert.isTrue(isUsageLimitError("You've hit your usage limit"))
    assert.isTrue(isUsageLimitError("too many requests"))
    assert.isFalse(isUsageLimitError("model_not_found"))
    assert.isFalse(isUsageLimitError("model_not_found: usage limit"))
    assert.isFalse(isUsageLimitError("server_error: too many requests"))
    assert.isFalse(isUsageLimitError("server_error: the assistant said rate limit"))
    assert.isFalse(isUsageLimitError("aborted"))
    assert.isFalse(isUsageLimitError(undefined))
    assert.strictEqual(outcome("t", undefined), 'Agent "t" finished')
    assert.strictEqual(outcome("t", "boom"), 'Agent "t" failed: boom')
  })
})

const launchInput: LaunchInput = {
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
    const input: CoordinatorInput = {
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
    for (const id of HARNESS_IDS)
      if (ADAPTERS[id].coordinatorArgs) assert.isFalse(hasNewline(ADAPTERS[id].coordinatorArgs!(input)))
  })

  it("Sessions get no vibest MCP server: claude may run vibest report, and read and edit in the project folder", () => {
    for (const id of HARNESS_IDS)
      assert.isEmpty(
        ADAPTERS[id].launchArgs(input).filter((a) => /mcp/i.test(a)),
        id,
      )
    const claude = ADAPTERS.claude.launchArgs(input)
    assert.strictEqual(
      claude[claude.indexOf("--allowedTools") + 1],
      `Bash(vibest report:*),Bash(/usr/bin/bun /src/main.ts report:*),Read(/${input.projectDir}/**),Edit(/${input.projectDir}/**)`,
    )
    assert.strictEqual(claude[claude.indexOf("--add-dir") + 1], input.projectDir)
  })
})

describe("pure", () => {
  it.effect("~/.vibest layout: VIBEST_HOME, else $HOME/.vibest; the old product's OMO_HOME is not read", () =>
    Effect.gen(function* () {
      const layout = (env: Record<string, string>) =>
        Effect.gen(function* () {
          return yield* Layout
        }).pipe(
          Effect.provide(Layout.layer),
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
          Effect.provide(Platform.services),
        )
      const withOmoHome = yield* layout({ HOME: "/h", OMO_HOME: "/old" })
      assert.deepInclude(withOmoHome, {
        home: "/h/.vibest",
        database: "/h/.vibest/vibest.db",
        socket: "/h/.vibest/vibest.sock",
        config: "/h/.vibest/vibest.json",
      })
      assert.strictEqual((yield* layout({ HOME: "/h", VIBEST_HOME: "/x" })).home, "/x")
    }),
  )

  it("summary is the first non-empty line cut to about 120 characters; the Remember section is still picked up", () => {
    const r = parseReport("\n  \nFixed it. Tests pass.\nmore\n\n## Remember\nuse bun\n\n## Other\nx")
    assert.deepStrictEqual(r, { summary: "Fixed it. Tests pass.", remember: "use bun" })
    assert.deepStrictEqual(parseReport(""), { summary: undefined, remember: undefined })
    const long = parseReport("x".repeat(200)).summary!
    assert.strictEqual(long.length, 120)
    assert.isTrue(long.endsWith("…"))
    assert.strictEqual(parseReport("status: needs_input\nwhich one?").summary, "status: needs_input")
  })

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

  it("normalizeModels: one Model shape, requested provider filled in, other providers dropped", () => {
    assert.deepStrictEqual(
      normalizeModels("pi", "azure", [
        { model: "gpt-5", description: "older", default: true },
        { model: "gpt-6", name: "GPT-6", default: false },
      ]),
      [
        { harness: "pi", provider: "azure", model: "gpt-5", name: "gpt-5", description: "older", default: true },
        { harness: "pi", provider: "azure", model: "gpt-6", name: "GPT-6", description: "", default: false },
      ],
    )
    const pi = [
      { provider: "xai", model: "grok", default: false },
      { provider: "zai", model: "grok", default: false },
    ]
    assert.deepStrictEqual(
      normalizeModels("pi", null, pi).map((m) => m.provider),
      ["xai", "zai"],
    )
    assert.deepStrictEqual(
      normalizeModels("pi", "zai", pi).map((m) => m.provider),
      ["zai"],
    )
  })

  it("shell quoting", () => {
    assert.strictEqual(shellQuote("/usr/bin/vibest"), "/usr/bin/vibest")
    assert.strictEqual(shellQuote("a b"), "'a b'")
    assert.strictEqual(shellQuote("it's"), "'it'\\''s'")
    assert.strictEqual(shellQuote(""), "''")
  })
})
