# Claude Code SDK-Typed Tools & Data Parts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace hand-written zod schemas for Claude Code tools and domain types with types imported directly from `@anthropic-ai/claude-agent-sdk`, switch tool outputs to the structured `tool_use_result`, and add SDK-message-backed `data-*` parts.

**Architecture:** Tool input/output types become `z.custom<SdkType>()` typed pass-throughs (zero validation, zero drift) in a single registry file, mirroring the reference implementation at `/Users/dinq/Work/neo-projects/neo-monorepo/packages/contract/src/agent/claude-code/`. The transform becomes a stateful factory that emits `tool_use_result` as tool output (no content fallback), flags non-registry tools as `dynamic`, and forwards whole SDK messages as `data-*` parts. The oRPC contract switches trusted outputs to `type<T>()` passthrough.

**Tech Stack:** TypeScript 7 (tsgo), zod 4, ai (AI SDK) v7, `@anthropic-ai/claude-agent-sdk` 0.3.207 (`/sdk-tools` subpath), oRPC, vitest via Vite+ (`vp`).

## Global Constraints

- Reference implementation (read-only): `/Users/dinq/Work/neo-projects/neo-monorepo` — patterns are ported, names are adapted to vibest's existing exported names.
- Keep vibest's existing public names: registry `claudeCodeTools`, type `ClaudeCodeTools`, per-tool consts (`Bash`, `Read`, …) and `<Tool>UIToolInvocation` types. Definitions stay in `@vibest/harness` (NOT moved to `@vibest/contract`).
- Tool output = `tool_use_result` ONLY on success (no `part.content` fallback); error branch uses flattened `part.content` as `errorText`. Decision confirmed in grilling session 2026-07-12.
- Legacy tools `MultiEdit` / `SlashCommand` / `BashOutput` / `KillShell` keep their current hand-written zod schemas unchanged (they no longer occur on CLI ≥ 0.3.x wire; kept for typed UI components).
- No cold-read history / tee-store this round; live streams only. No `turn-file-changes` data part. `ClaudeCodeMetadata` stays `unknown`.
- Run all commands from the repo root. Verify: `vp check` (fmt+lint+types) and `vp test run` must pass at every commit.
- Do not add Claude-related annotations to commit messages.

---

### Task 1: Pin the SDK version

The SDK's types become the package's public API in this refactor; a caret range would let `pnpm install` silently change the API surface.

**Files:**

- Modify: `packages/harness/package.json`
- Modify: `packages/contract/package.json`
- Modify: `packages/vibest/package.json`

**Interfaces:**

- Produces: exact dependency `"@anthropic-ai/claude-agent-sdk": "0.3.207"` in all three packages.

- [ ] **Step 1: Pin the dependency in all three package.json files**

In each of the three files replace:

```json
"@anthropic-ai/claude-agent-sdk": "^0.3.207",
```

with:

```json
"@anthropic-ai/claude-agent-sdk": "0.3.207",
```

- [ ] **Step 2: Reinstall and verify the lockfile only narrows the range**

Run: `pnpm install`
Expected: exits 0; `git diff pnpm-lock.yaml` shows only specifier changes for `@anthropic-ai/claude-agent-sdk` (resolved version stays 0.3.207).

- [ ] **Step 3: Verify the `/sdk-tools` subpath resolves under TS**

Create a scratch check (do not commit): add `import type { BashInput } from "@anthropic-ai/claude-agent-sdk/sdk-tools";` plus `const _t: BashInput = { command: "ls" };` temporarily at the top of `packages/harness/src/claude-code/agent.ts`, run `pnpm --filter @vibest/harness typecheck`, expect PASS, then revert the scratch edit.

- [ ] **Step 4: Commit**

```bash
git add packages/harness/package.json packages/contract/package.json packages/vibest/package.json pnpm-lock.yaml
git commit -m "chore(harness): pin claude-agent-sdk to exact 0.3.207"
```

---

### Task 2: SDK-typed tool registry

Replace the 18 per-tool files under `packages/harness/src/claude-code/tools/` with a single `tools.ts`: 23 tools typed via `z.custom<SdkType>()` + the 4 legacy hand-written tools moved verbatim. This is the pattern from neo's `packages/contract/src/agent/claude-code/tools.ts` (read it before starting).

**Files:**

- Create: `packages/harness/src/claude-code/tools.ts`
- Create: `packages/harness/test/claude-code/tools.test-d.ts`
- Delete: `packages/harness/src/claude-code/tools/` (all 18 files, including the never-registered `list-mcp-resources.ts` / `read-mcp-resource.ts`)
- Modify: `packages/harness/src/claude-code/index.ts`

**Interfaces:**

- Produces: `claudeCodeTools` (registry object, 27 keys, `satisfies ToolSet`), `ClaudeCodeTools = InferUITools<typeof claudeCodeTools>`, per-tool consts and `<Name>UIToolInvocation` types for every registry entry.
- Consumers (`packages/ui`, `packages/contract`, `apps/web`) keep importing the same names from `@vibest/harness/claude-code` — no import churn outside harness.

- [ ] **Step 1: Write the type test first**

Create `packages/harness/test/claude-code/tools.test-d.ts`:

```ts
import type * as st from "@anthropic-ai/claude-agent-sdk/sdk-tools";
import { describe, expectTypeOf, test } from "vitest";
import type { ClaudeCodeTools } from "../../src/claude-code";

type In<K extends keyof ClaudeCodeTools> = ClaudeCodeTools[K]["input"];
type Out<K extends keyof ClaudeCodeTools> = ClaudeCodeTools[K]["output"];

describe("SDK-typed tools: input/output ARE the sdk-tools types", () => {
  test("inputs", () => {
    expectTypeOf<In<"Bash">>().toEqualTypeOf<st.BashInput>();
    expectTypeOf<In<"Read">>().toEqualTypeOf<st.FileReadInput>();
    expectTypeOf<In<"Edit">>().toEqualTypeOf<st.FileEditInput>();
    expectTypeOf<In<"Write">>().toEqualTypeOf<st.FileWriteInput>();
    expectTypeOf<In<"Glob">>().toEqualTypeOf<st.GlobInput>();
    expectTypeOf<In<"Grep">>().toEqualTypeOf<st.GrepInput>();
    expectTypeOf<In<"Agent">>().toEqualTypeOf<st.AgentInput>();
    expectTypeOf<In<"Task">>().toEqualTypeOf<st.AgentInput>();
    expectTypeOf<In<"TaskOutput">>().toEqualTypeOf<st.TaskOutputInput>();
    expectTypeOf<In<"TaskStop">>().toEqualTypeOf<st.TaskStopInput>();
    expectTypeOf<In<"TaskCreate">>().toEqualTypeOf<st.TaskCreateInput>();
    expectTypeOf<In<"TaskUpdate">>().toEqualTypeOf<st.TaskUpdateInput>();
    expectTypeOf<In<"TaskGet">>().toEqualTypeOf<st.TaskGetInput>();
    expectTypeOf<In<"TaskList">>().toEqualTypeOf<st.TaskListInput>();
    expectTypeOf<In<"NotebookEdit">>().toEqualTypeOf<st.NotebookEditInput>();
    expectTypeOf<In<"TodoWrite">>().toEqualTypeOf<st.TodoWriteInput>();
    expectTypeOf<In<"WebFetch">>().toEqualTypeOf<st.WebFetchInput>();
    expectTypeOf<In<"WebSearch">>().toEqualTypeOf<st.WebSearchInput>();
    expectTypeOf<In<"AskUserQuestion">>().toEqualTypeOf<st.AskUserQuestionInput>();
    expectTypeOf<In<"EnterPlanMode">>().toEqualTypeOf<st.EnterPlanModeInput>();
    expectTypeOf<In<"ExitPlanMode">>().toEqualTypeOf<st.ExitPlanModeInput>();
    expectTypeOf<In<"EnterWorktree">>().toEqualTypeOf<st.EnterWorktreeInput>();
    expectTypeOf<In<"ExitWorktree">>().toEqualTypeOf<st.ExitWorktreeInput>();
  });

  test("outputs", () => {
    expectTypeOf<Out<"Bash">>().toEqualTypeOf<st.BashOutput>();
    expectTypeOf<Out<"Read">>().toEqualTypeOf<st.FileReadOutput>();
    expectTypeOf<Out<"Edit">>().toEqualTypeOf<st.FileEditOutput>();
    expectTypeOf<Out<"Write">>().toEqualTypeOf<st.FileWriteOutput>();
    expectTypeOf<Out<"Glob">>().toEqualTypeOf<st.GlobOutput>();
    expectTypeOf<Out<"Grep">>().toEqualTypeOf<st.GrepOutput>();
    expectTypeOf<Out<"Agent">>().toEqualTypeOf<st.AgentOutput>();
    expectTypeOf<Out<"TaskStop">>().toEqualTypeOf<st.TaskStopOutput>();
    expectTypeOf<Out<"TodoWrite">>().toEqualTypeOf<st.TodoWriteOutput>();
    expectTypeOf<Out<"WebFetch">>().toEqualTypeOf<st.WebFetchOutput>();
    expectTypeOf<Out<"WebSearch">>().toEqualTypeOf<st.WebSearchOutput>();
    expectTypeOf<Out<"AskUserQuestion">>().toEqualTypeOf<st.AskUserQuestionOutput>();
  });

  test("legacy hand-written tools keep their shapes", () => {
    expectTypeOf<In<"MultiEdit">>().toEqualTypeOf<{
      file_path: string;
      edits: { old_string: string; new_string: string; replace_all?: boolean }[];
    }>();
    expectTypeOf<Out<"MultiEdit">>().toEqualTypeOf<string>();
    expectTypeOf<In<"SlashCommand">>().toEqualTypeOf<{ command: string }>();
    expectTypeOf<In<"BashOutput">>().toEqualTypeOf<{ bash_id: string; filter?: string }>();
    expectTypeOf<In<"KillShell">>().toEqualTypeOf<{ shell_id: string }>();
  });
});
```

- [ ] **Step 2: Run the type test to verify it fails**

Run: `pnpm --filter @vibest/harness typecheck`
Expected: FAIL — `In<"Agent">`, `In<"TaskOutput">` etc. don't exist yet (registry has no such keys).

- [ ] **Step 3: Write `packages/harness/src/claude-code/tools.ts`**

Namespace-import `sdk-tools` to avoid the `BashOutput` name collision (SDK type `BashOutput` vs the legacy tool const `BashOutput`):

```ts
import { tool, type InferUITools, type ToolSet, type UIToolInvocation } from "ai";
import { z } from "zod";
import type * as st from "@anthropic-ai/claude-agent-sdk/sdk-tools";

// Claude Code tool schemas, bound directly to `@anthropic-ai/claude-agent-sdk/sdk-tools`.
//
// `z.custom<SdkType>()` rather than hand-written field-by-field zod:
//   • `z.infer<typeof z.custom<T>()>` IS `T` — the UI tool types are exactly the
//     SDK's generated types, with zero hand-transcription and zero drift.
//   • `tool()` only needs a schema OBJECT for `InferUITools` to read; the transform
//     forwards `input` / `tool_use_result` VERBATIM and never validates, so
//     `z.custom` is a typed pass-through with no runtime checking.
//
// All tools run inside the Claude Code process (provider-executed). Tools the SDK
// exports no type for (Cron*/ToolSearch/ScheduleWakeup/Skill/Workflow/… and any
// MCP tool) are NOT in the registry: the transform flags them `dynamic` and the
// UI renders them generically.

export const Bash = tool({
  inputSchema: z.custom<st.BashInput>(),
  outputSchema: z.custom<st.BashOutput>(),
});
export const Read = tool({
  inputSchema: z.custom<st.FileReadInput>(),
  outputSchema: z.custom<st.FileReadOutput>(),
}); // SDK: FileRead
export const Edit = tool({
  inputSchema: z.custom<st.FileEditInput>(),
  outputSchema: z.custom<st.FileEditOutput>(),
}); // SDK: FileEdit
export const Write = tool({
  inputSchema: z.custom<st.FileWriteInput>(),
  outputSchema: z.custom<st.FileWriteOutput>(),
}); // SDK: FileWrite
export const Glob = tool({
  inputSchema: z.custom<st.GlobInput>(),
  outputSchema: z.custom<st.GlobOutput>(),
});
export const Grep = tool({
  inputSchema: z.custom<st.GrepInput>(),
  outputSchema: z.custom<st.GrepOutput>(),
});
export const Agent = tool({
  inputSchema: z.custom<st.AgentInput>(),
  outputSchema: z.custom<st.AgentOutput>(),
});
export const Task = Agent; // the SDK accepts `Task` as an alias of `Agent`
export const TaskOutput = tool({
  inputSchema: z.custom<st.TaskOutputInput>(),
  outputSchema: z.unknown(),
}); // SDK exports no TaskOutputOutput
export const TaskStop = tool({
  inputSchema: z.custom<st.TaskStopInput>(),
  outputSchema: z.custom<st.TaskStopOutput>(),
});
export const TaskCreate = tool({
  inputSchema: z.custom<st.TaskCreateInput>(),
  outputSchema: z.custom<st.TaskCreateOutput>(),
});
export const TaskUpdate = tool({
  inputSchema: z.custom<st.TaskUpdateInput>(),
  outputSchema: z.custom<st.TaskUpdateOutput>(),
});
export const TaskGet = tool({
  inputSchema: z.custom<st.TaskGetInput>(),
  outputSchema: z.custom<st.TaskGetOutput>(),
});
export const TaskList = tool({
  inputSchema: z.custom<st.TaskListInput>(),
  outputSchema: z.custom<st.TaskListOutput>(),
});
export const NotebookEdit = tool({
  inputSchema: z.custom<st.NotebookEditInput>(),
  outputSchema: z.custom<st.NotebookEditOutput>(),
});
export const TodoWrite = tool({
  inputSchema: z.custom<st.TodoWriteInput>(),
  outputSchema: z.custom<st.TodoWriteOutput>(),
});
export const WebFetch = tool({
  inputSchema: z.custom<st.WebFetchInput>(),
  outputSchema: z.custom<st.WebFetchOutput>(),
});
export const WebSearch = tool({
  inputSchema: z.custom<st.WebSearchInput>(),
  outputSchema: z.custom<st.WebSearchOutput>(),
});
export const AskUserQuestion = tool({
  inputSchema: z.custom<st.AskUserQuestionInput>(),
  outputSchema: z.custom<st.AskUserQuestionOutput>(),
});
export const EnterPlanMode = tool({
  inputSchema: z.custom<st.EnterPlanModeInput>(),
  outputSchema: z.custom<st.EnterPlanModeOutput>(),
});
export const ExitPlanMode = tool({
  inputSchema: z.custom<st.ExitPlanModeInput>(),
  outputSchema: z.custom<st.ExitPlanModeOutput>(),
});
export const EnterWorktree = tool({
  inputSchema: z.custom<st.EnterWorktreeInput>(),
  outputSchema: z.custom<st.EnterWorktreeOutput>(),
});
export const ExitWorktree = tool({
  inputSchema: z.custom<st.ExitWorktreeInput>(),
  outputSchema: z.custom<st.ExitWorktreeOutput>(),
});

// ── Legacy tools (pre-rename CLI wire names; SDK exports no types for them). ──
// Kept hand-written so their typed UI components keep working on replayed
// transcripts. They no longer occur on the current CLI (BashOutput→TaskOutput,
// KillShell→TaskStop; MultiEdit and SlashCommand were removed upstream).

export const MultiEdit = tool({
  inputSchema: z.object({
    file_path: z.string(),
    edits: z.array(
      z.object({
        old_string: z.string(),
        new_string: z.string(),
        replace_all: z.boolean().optional(),
      }),
    ),
  }),
  outputSchema: z.string(),
});
export const SlashCommand = tool({
  inputSchema: z.object({
    command: z.string(),
  }),
  outputSchema: z.string(),
});
export const BashOutput = tool({
  inputSchema: z.object({
    bash_id: z.string(),
    filter: z.string().optional(),
  }),
  outputSchema: z.string(),
});
export const KillShell = tool({
  inputSchema: z.object({
    shell_id: z.string(),
  }),
  outputSchema: z.string(),
});

/** Registry of typed Claude Code tools. Keys are the wire tool names. */
export const claudeCodeTools = {
  Bash,
  Read,
  Edit,
  Write,
  Glob,
  Grep,
  Agent,
  Task,
  TaskOutput,
  TaskStop,
  TaskCreate,
  TaskUpdate,
  TaskGet,
  TaskList,
  NotebookEdit,
  TodoWrite,
  WebFetch,
  WebSearch,
  AskUserQuestion,
  EnterPlanMode,
  ExitPlanMode,
  EnterWorktree,
  ExitWorktree,
  MultiEdit,
  SlashCommand,
  BashOutput,
  KillShell,
} satisfies ToolSet;

/** Discriminated UI tool union, keyed `tool-Bash` | `tool-Read` | … */
export type ClaudeCodeTools = InferUITools<typeof claudeCodeTools>;

export type BashUIToolInvocation = UIToolInvocation<typeof Bash>;
export type ReadUIToolInvocation = UIToolInvocation<typeof Read>;
export type EditUIToolInvocation = UIToolInvocation<typeof Edit>;
export type WriteUIToolInvocation = UIToolInvocation<typeof Write>;
export type GlobUIToolInvocation = UIToolInvocation<typeof Glob>;
export type GrepUIToolInvocation = UIToolInvocation<typeof Grep>;
export type TaskUIToolInvocation = UIToolInvocation<typeof Task>;
export type TaskOutputUIToolInvocation = UIToolInvocation<typeof TaskOutput>;
export type TaskStopUIToolInvocation = UIToolInvocation<typeof TaskStop>;
export type TaskCreateUIToolInvocation = UIToolInvocation<typeof TaskCreate>;
export type TaskUpdateUIToolInvocation = UIToolInvocation<typeof TaskUpdate>;
export type TaskGetUIToolInvocation = UIToolInvocation<typeof TaskGet>;
export type TaskListUIToolInvocation = UIToolInvocation<typeof TaskList>;
export type NotebookEditUIToolInvocation = UIToolInvocation<typeof NotebookEdit>;
export type TodoWriteUIToolInvocation = UIToolInvocation<typeof TodoWrite>;
export type WebFetchUIToolInvocation = UIToolInvocation<typeof WebFetch>;
export type WebSearchUIToolInvocation = UIToolInvocation<typeof WebSearch>;
export type AskUserQuestionUIToolInvocation = UIToolInvocation<typeof AskUserQuestion>;
export type EnterPlanModeUIToolInvocation = UIToolInvocation<typeof EnterPlanMode>;
export type ExitPlanModeUIToolInvocation = UIToolInvocation<typeof ExitPlanMode>;
export type EnterWorktreeUIToolInvocation = UIToolInvocation<typeof EnterWorktree>;
export type ExitWorktreeUIToolInvocation = UIToolInvocation<typeof ExitWorktree>;
export type MultiEditUIToolInvocation = UIToolInvocation<typeof MultiEdit>;
export type SlashCommandUIToolInvocation = UIToolInvocation<typeof SlashCommand>;
export type BashOutputUIToolInvocation = UIToolInvocation<typeof BashOutput>;
export type KillShellUIToolInvocation = UIToolInvocation<typeof KillShell>;
```

Note: the AI SDK v7 `tool()` overload requires a concrete schema type — each `z.custom<st.X>()` must appear inline (no wrapper helper), same constraint neo documents.

- [ ] **Step 4: Delete the old per-tool files and rewire index.ts**

Delete the whole directory `packages/harness/src/claude-code/tools/`.

In `packages/harness/src/claude-code/index.ts` replace the 16 per-tool `import`s (lines 3–18), the 16 per-tool `export`s (lines 22–37) and the `claudeCodeTools` object + `ClaudeCodeTools` type (lines 39–61) with:

```ts
export * from "./tools";
import { claudeCodeTools } from "./tools";
```

(The `export * from "./tools"` re-exports every tool const, the registry, `ClaudeCodeTools`, and every `<Name>UIToolInvocation` under their existing names. The extra value import stays only if something else in index.ts references `claudeCodeTools`; otherwise drop it.)

- [ ] **Step 5: Typecheck and run tests**

Run: `pnpm --filter @vibest/harness typecheck && pnpm --filter @vibest/harness test`
Expected: typecheck PASS (Step 1's test-d now compiles). Runtime tests still PASS (transform untouched so far). `vp check` may flag downstream packages — those are fixed in Tasks 5–6; only harness must be green here.

- [ ] **Step 6: Commit**

```bash
git add -A packages/harness
git commit -m "refactor(harness): SDK-typed claude-code tool registry via z.custom"
```

---

### Task 3: Data parts on ClaudeCodeUIMessage

**Files:**

- Modify: `packages/harness/src/claude-code/ui-message.ts`

**Interfaces:**

- Produces: `ClaudeCodeDataTypes` with keys `"system/init"`, `"system/compact_boundary"`, `"result/success"`, `` `result/${SDKResultError["subtype"]}` ``, `"user-prompt"`. Chunk types become `data-system/init` etc. (no `.` in any chunk type — the envelope's `isSessionEvent` dot-routing in `packages/harness/src/types/envelope.ts:33` is unaffected).

- [ ] **Step 1: Replace the file content**

```ts
import type {
  SDKCompactBoundaryMessage,
  SDKResultError,
  SDKResultSuccess,
  SDKSystemMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { UIMessage } from "ai";
import type { ClaudeCodeTools } from "./tools";

export type ClaudeCodeMetadata = unknown;

// `data-*` parts carry the WHOLE SDK message as payload — the transform forwards
// `data: msg` verbatim, so the renderer keeps full fidelity. `result/<subtype>`
// is keyed off every SDKResultError subtype plus the success case.
export type ClaudeCodeDataTypes = {
  "system/init": SDKSystemMessage;
  "system/compact_boundary": SDKCompactBoundaryMessage;
  "result/success": SDKResultSuccess;
  /**
   * History replay only. The live transform never emits the user's own prompt;
   * a future transcript replayer emits the whole user record here.
   */
  "user-prompt": SDKUserMessage;
} & { [K in SDKResultError["subtype"] as `result/${K}`]: SDKResultError };

export type ClaudeCodeUIMessage = UIMessage<
  ClaudeCodeMetadata,
  ClaudeCodeDataTypes,
  ClaudeCodeTools
>;
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @vibest/harness typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/harness/src/claude-code/ui-message.ts
git commit -m "feat(harness): SDK-message-backed data parts on ClaudeCodeUIMessage"
```

---

### Task 4: Transform factory — tool_use_result outputs, dynamic flag, data-* chunks

The transform gains cross-message state (the `dynamic` classification of each tool call must be replayed onto its later tool_result, which carries no tool name), so it becomes a factory. `toUIMessage` currently duplicates the whole mapping (`packages/harness/src/claude-code/utils/to-ui-message.ts`) — it is rewritten to wrap the one transform.

**Files:**

- Create: `packages/harness/src/claude-code/render-policy.ts`
- Modify: `packages/harness/src/claude-code/transform.ts` (full rewrite)
- Modify: `packages/harness/src/claude-code/utils/to-ui-message.ts` (full rewrite)
- Modify: `packages/harness/src/claude-code/fold.ts`
- Modify: `packages/harness/src/claude-code/index.ts` (export `createTransform` instead of `transform`)
- Test: `packages/harness/test/claude-code/transform.test.ts` (rewrite), `packages/harness/test/claude-code/fold.test.ts` (adjust fixtures), `packages/harness/test/exports.test.ts` (rename)

**Interfaces:**

- Produces: `createTransform(): (message: SDKMessage) => Generator<ClaudeCodeUIMessageChunk>`; `subagentMetadata(parent: string | null)`; `flattenToolResultText(content: unknown): string`.
- Consumes: `claudeCodeTools` (registry keys drive the `dynamic` flag).

- [ ] **Step 1: Rewrite the transform tests first**

Replace `packages/harness/test/claude-code/transform.test.ts` with:

```ts
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { createTransform } from "../../src/claude-code/transform";

const types = (chunks: unknown[]) => chunks.map((c) => (c as { type: string }).type);

const toolUse = (name: string, id = "t1"): SDKMessage =>
  ({
    type: "assistant",
    parent_tool_use_id: null,
    message: { id: "m1", content: [{ type: "tool_use", id, name, input: { command: "ls" } }] },
  }) as unknown as SDKMessage;

const toolResult = (over: Record<string, unknown> = {}, id = "t1"): SDKMessage =>
  ({
    type: "user",
    parent_tool_use_id: null,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "1→hi" }] },
    tool_use_result: { type: "text", file: { filePath: "/a", content: "hi" } },
    ...over,
  }) as unknown as SDKMessage;

describe("createTransform", () => {
  it("emits start + data-system/init for system.init", () => {
    const transform = createTransform();
    const chunks = [...transform({ type: "system", subtype: "init" } as SDKMessage)];
    expect(types(chunks)).toEqual(["start", "data-system/init"]);
  });

  it("tool output is the structured tool_use_result, not the model-facing content", () => {
    const transform = createTransform();
    [...transform(toolUse("Read"))];
    const chunks = [...transform(toolResult())];
    expect(chunks[0]).toMatchObject({
      type: "tool-output-available",
      toolCallId: "t1",
      output: { type: "text", file: { filePath: "/a", content: "hi" } },
    });
  });

  it("missing tool_use_result yields undefined output (no content fallback)", () => {
    const transform = createTransform();
    [...transform(toolUse("Bash"))];
    const chunks = [...transform(toolResult({ tool_use_result: undefined }))];
    expect(chunks[0]).toMatchObject({ type: "tool-output-available", output: undefined });
  });

  it("registry tools are dynamic:false, unknown tools dynamic:true — on input AND output", () => {
    const transform = createTransform();
    const known = [...transform(toolUse("Bash", "k1"))];
    const unknown = [...transform(toolUse("mcp__foo__bar", "u1"))];
    expect(known[0]).toMatchObject({ dynamic: false });
    expect(unknown[0]).toMatchObject({ dynamic: true });
    const knownOut = [...transform(toolResult({}, "k1"))];
    const unknownOut = [...transform(toolResult({}, "u1"))];
    expect(knownOut[0]).toMatchObject({ dynamic: false });
    expect(unknownOut[0]).toMatchObject({ dynamic: true });
  });

  it("error results flatten content into errorText", () => {
    const transform = createTransform();
    [...transform(toolUse("Bash"))];
    const msg = {
      type: "user",
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            is_error: true,
            content: [{ type: "text", text: "boom" }],
          },
        ],
      },
    } as unknown as SDKMessage;
    const chunks = [...transform(msg)];
    expect(chunks[0]).toMatchObject({ type: "tool-output-error", errorText: "boom" });
  });

  it("result.success emits data-result/success + finish", () => {
    const transform = createTransform();
    const chunks = [...transform({ type: "result", subtype: "success" } as SDKMessage)];
    expect(types(chunks)).toEqual(["data-result/success", "finish"]);
  });

  it("result errors emit error + data-result/<subtype> + finish", () => {
    const transform = createTransform();
    const chunks = [
      ...transform({
        type: "result",
        subtype: "error_max_turns",
        errors: ["too many turns"],
      } as unknown as SDKMessage),
    ];
    expect(types(chunks)).toEqual(["error", "data-result/error_max_turns", "finish"]);
    expect(chunks[0]).toMatchObject({ errorText: "too many turns" });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @vibest/harness test`
Expected: FAIL — `createTransform` is not exported.

- [ ] **Step 3: Create render-policy.ts**

`packages/harness/src/claude-code/render-policy.ts` (ported from neo `packages/server/src/features/agent/providers/claude-code/render-policy.ts`):

```ts
/** Part-level subagent attribution. Spread into a chunk. */
export function subagentMetadata(parent: string | null) {
  return parent != null ? { providerMetadata: { claudeCode: { parentToolUseId: parent } } } : {};
}

/** Flatten tool_result content to a string; non-text blocks are JSON-serialized, not dropped. */
export function flattenToolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        block != null && typeof block === "object" && (block as { type?: unknown }).type === "text"
          ? String((block as { text?: unknown }).text ?? "")
          : JSON.stringify(block),
      )
      .join("\n");
  }
  return content != null ? JSON.stringify(content) : "";
}
```

- [ ] **Step 4: Rewrite transform.ts**

```ts
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { generateId } from "ai";
import type { ClaudeCodeUIMessageChunk } from "../types/envelope";
import { claudeCodeTools } from "./tools";
import { flattenToolResultText, subagentMetadata } from "./render-policy";

/**
 * Per-session render transform factory. State: each tool call's `dynamic`
 * classification, replayed onto its tool_result (which carries no tool name).
 *
 * Policy (decided 2026-07-12):
 *   • tool output = the structured `tool_use_result`; NO content fallback —
 *     subagent messages omit it, so their output stays undefined.
 *   • tool errors = flattened model-facing content as errorText.
 *   • system/result messages are forwarded whole as `data-*` parts.
 */
export function createTransform(): (message: SDKMessage) => Generator<ClaudeCodeUIMessageChunk> {
  const dynamicToolCalls = new Map<string, boolean>();

  return function* transform(message) {
    switch (message.type) {
      case "system": {
        if (message.subtype === "init") {
          yield { type: "start" };
          yield { type: "data-system/init", data: message };
        } else if (message.subtype === "compact_boundary") {
          yield { type: "data-system/compact_boundary", data: message };
        }
        return;
      }
      case "assistant": {
        const parent = message.parent_tool_use_id;
        for (const part of message.message.content) {
          if (part.type === "text") {
            const id = message.message.id;
            yield { type: "text-start", id, ...subagentMetadata(parent) };
            yield { type: "text-delta", id, delta: part.text, ...subagentMetadata(parent) };
            yield { type: "text-end", id, ...subagentMetadata(parent) };
          } else if (part.type === "tool_use") {
            const dynamic = !(part.name in claudeCodeTools);
            dynamicToolCalls.set(part.id, dynamic);
            yield {
              type: "tool-input-available",
              toolCallId: part.id,
              toolName: part.name,
              input: part.input,
              providerExecuted: true,
              dynamic,
              ...subagentMetadata(parent),
            };
          }
        }
        return;
      }
      case "user": {
        const parent = message.parent_tool_use_id;
        if (typeof message.message.content === "string") {
          const id = generateId();
          yield { type: "text-start", id };
          yield { type: "text-delta", id, delta: message.message.content };
          yield { type: "text-end", id };
          return;
        }
        const toolUseResult = "tool_use_result" in message ? message.tool_use_result : undefined;
        for (const part of message.message.content) {
          if (part.type !== "tool_result") continue;
          const dynamic = dynamicToolCalls.get(part.tool_use_id) ?? false;
          if (part.is_error) {
            yield {
              type: "tool-output-error",
              toolCallId: part.tool_use_id,
              errorText: flattenToolResultText(part.content),
              dynamic,
              ...subagentMetadata(parent),
            };
          } else {
            yield {
              type: "tool-output-available",
              toolCallId: part.tool_use_id,
              output: toolUseResult,
              providerExecuted: true,
              dynamic,
              ...subagentMetadata(parent),
            };
          }
        }
        return;
      }
      case "result": {
        if (message.subtype !== "success") {
          yield { type: "error", errorText: resultErrorText(message) };
        }
        // Emit per-subtype so the discriminated `type`↔`data` pairing holds
        // without a cast — a template-literal type would widen the union.
        switch (message.subtype) {
          case "success":
            yield { type: "data-result/success", data: message };
            break;
          case "error_during_execution":
            yield { type: "data-result/error_during_execution", data: message };
            break;
          case "error_max_budget_usd":
            yield { type: "data-result/error_max_budget_usd", data: message };
            break;
          case "error_max_structured_output_retries":
            yield { type: "data-result/error_max_structured_output_retries", data: message };
            break;
          case "error_max_turns":
            yield { type: "data-result/error_max_turns", data: message };
            break;
        }
        yield { type: "finish" };
        return;
      }
    }
  };
}

function resultErrorText(message: Extract<SDKMessage, { type: "result" }>): string {
  const errors = "errors" in message && Array.isArray(message.errors) ? message.errors : [];
  return errors.join("\n") || `An unexpected error occurred (${message.subtype})`;
}
```

Note: if tsgo reports that `SDKResultError["subtype"]` has members this switch doesn't cover (the SDK may add subtypes), add the missing `case` arms — the test-d/typecheck is the guard. If `dynamic` is rejected on the chunk type by ai v7, check `InferUIMessageChunk`'s `tool-input-available` member for the exact optional flag name before changing anything.

- [ ] **Step 5: Rewrite utils/to-ui-message.ts to wrap the transform**

```ts
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeCodeUIMessageChunk } from "../../types/envelope";
import { createTransform } from "../transform";

export async function* toUIMessage(
  iterator: AsyncGenerator<SDKMessage, void, unknown>,
): AsyncGenerator<ClaudeCodeUIMessageChunk> {
  const transform = createTransform();
  for await (const message of iterator) {
    yield* transform(message);
  }
}
```

The old generic parameter `<T extends UIMessage>` is dropped; the server RPC call site (`packages/server/src/rpc/claude-code.ts:79` `toUIMessage(...)`) passes no type argument, so it keeps compiling — the contract output type is aligned in Task 5.

- [ ] **Step 6: Update fold.ts and the exports**

In `packages/harness/src/claude-code/fold.ts` replace `import { transform } from "./transform";` with `import { createTransform } from "./transform";` and inside `foldToUIMessages` create the instance before the loop:

```ts
const transform = createTransform();
```

In `packages/harness/src/claude-code/index.ts` replace `export { transform } from "./transform";` with:

```ts
export { createTransform } from "./transform";
export { flattenToolResultText, subagentMetadata } from "./render-policy";
```

In `packages/harness/test/exports.test.ts` replace the `transform` import/assert with `createTransform`.

- [ ] **Step 7: Fix fold.test.ts fixtures**

Read `packages/harness/test/claude-code/fold.test.ts`; wherever a fixture `user` message expects the tool output to equal the tool_result `content`, add a `tool_use_result` field to the fixture message and assert the folded part's `output` equals it. Fixtures without `tool_use_result` now fold to `output: undefined` — update the assertions accordingly, and add `data-result/success` / `data-system/init` parts to expected messages where `system`/`result` fixtures are folded.

- [ ] **Step 8: Run harness tests**

Run: `pnpm --filter @vibest/harness test && pnpm --filter @vibest/harness typecheck`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add -A packages/harness
git commit -m "feat(harness): tool_use_result outputs, dynamic flag, data-* chunks in claude-code transform"
```

---

### Task 5: Contract passthrough — delete hand-written domain schemas

**Files:**

- Delete: `packages/harness/src/claude-code/schema/` (whole dir)
- Delete: `packages/harness/test/schema-type-compatibility.test-d.ts`
- Modify: `packages/harness/src/claude-code/index.ts` (drop schema re-exports, lines 63–70)
- Modify: `packages/contract/src/claude-code.ts`
- Modify: `apps/web/src/components/claude-code-message-parts.tsx`

**Interfaces:**

- Produces: contract outputs typed directly by SDK types via oRPC `type<T>()`; `respondPermission` input carries `z.custom<sdk.PermissionResult>()` (typed pass-through — the local client is trusted).
- The prompt stream output becomes `InferUIMessageChunk<ClaudeCodeUIMessage>` so data parts flow through typed.

- [ ] **Step 1: Delete the schema layer**

Delete `packages/harness/src/claude-code/schema/index.ts` and `packages/harness/test/schema-type-compatibility.test-d.ts`. Remove the `export { McpServerStatusSchema, ... } from "./schema";` block from `packages/harness/src/claude-code/index.ts`.

- [ ] **Step 2: Rewrite the contract to SDK-typed passthrough**

`packages/contract/src/claude-code.ts` — replace the schema imports and the five schema uses:

```ts
import type * as sdk from "@anthropic-ai/claude-agent-sdk";
import type { InferUIMessageChunk, UIMessage } from "ai";

import { oc, type } from "@orpc/contract";
import type { ClaudeCodeUIMessage, ToolPermissionRequest } from "@vibest/harness/claude-code";
import { z } from "zod";

export type { ToolPermissionRequest };

export const claudeCodeContract = {
  session: {
    create: oc.output(type<{ sessionId: string }>()),
    abort: oc.input(z.object({ sessionId: z.string() })),
    getSupportedCommands: oc
      .input(z.object({ sessionId: z.string() }))
      .output(type<sdk.SlashCommand[]>()),
    getSupportedModels: oc
      .input(z.object({ sessionId: z.string() }))
      .output(type<sdk.ModelInfo[]>()),
    getMcpServers: oc
      .input(z.object({ sessionId: z.string() }))
      .output(type<sdk.McpServerStatus[]>()),
  },
  prompt: oc
    .input(
      type<{
        sessionId: string;
        message: UIMessage;
        model?: string;
      }>(),
    )
    .output(type<AsyncGenerator<InferUIMessageChunk<ClaudeCodeUIMessage>>>()),
  requestPermission: oc
    .input(z.object({ sessionId: z.string() }))
    .output(type<AsyncGenerator<ToolPermissionRequest>>()),
  respondPermission: oc.input(
    z.object({
      sessionId: z.string(),
      requestId: z.string(),
      result: z.custom<sdk.PermissionResult>(),
    }),
  ),
};
```

Before writing, read the current file end-to-end (`packages/contract/src/claude-code.ts`) and keep any procedure not listed above verbatim (e.g. a `respondPermission` output). `ClaudeCodeUIMessage` must be exported from `@vibest/harness/claude-code` — it already is (`index.ts` line 77).

- [ ] **Step 3: Align the web app's message type**

`apps/web/src/components/claude-code-message-parts.tsx:8` currently narrows data types away:

```ts
export type ClaudeCodeUIMessage = UIMessage<undefined, Record<string, never>, ClaudeCodeTools>;
```

Replace with a re-export of the harness type:

```ts
export type { ClaudeCodeUIMessage } from "@vibest/harness/claude-code";
```

and adjust the imports in that file accordingly (drop unused `ClaudeCodeTools`/`UIMessage` type imports if now unused; the component's prop type stays `ClaudeCodeUIMessage`).

- [ ] **Step 4: Typecheck the workspace**

Run: `vp check`
Expected: harness/contract/web pass; `packages/ui` may fail on structured outputs — that is Task 6's job. If ONLY ui fails, proceed.

- [ ] **Step 5: Commit**

```bash
git add -A packages/harness packages/contract apps/web
git commit -m "refactor(contract): SDK-typed passthrough outputs, drop hand-written domain schemas"
```

---

### Task 6: UI components render structured outputs

Outputs changed type: `Bash` → `st.BashOutput` (`{stdout, stderr, interrupted, ...}`), `Read` → `st.FileReadOutput` (union on `type: "text" | "image" | ...`), `Glob` → `st.GlobOutput` (`{filenames, numFiles, ...}`), `Grep` → `st.GrepOutput` (`{mode?, content?, filenames, ...}`), `WebFetch` → `st.WebFetchOutput` (`{result, code, url, ...}`), `WebSearch` → `st.WebSearchOutput` (`{query, results: ({content: {title, url}[]} | string)[]}`), `Task` → `st.AgentOutput` (union; completed arm has `content: {type: "text", text}[]`). Input field names are unchanged (`file_path`, `old_string`, `todos`, …), so input-only components (`edit-tool`, `write-tool`, `todo-write-tool`, and the 4 legacy components) compile untouched.

**Files:**

- Modify: `packages/ui/src/claude-code/bash-tool.tsx`
- Modify: `packages/ui/src/claude-code/read-tool.tsx`
- Modify: `packages/ui/src/claude-code/glob-tool.tsx`
- Modify: `packages/ui/src/claude-code/grep-tool.tsx`
- Modify: `packages/ui/src/claude-code/web-fetch-tool.tsx`
- Modify: `packages/ui/src/claude-code/web-search-tool.tsx`
- Modify: `packages/ui/src/claude-code/task-tool.tsx`

- [ ] **Step 1: bash-tool.tsx — render stdout/stderr**

Replace the `terminalOutput` computation (the `output` variable is now `st.BashOutput | undefined`):

```ts
const outputText = output ? [output.stdout, output.stderr].filter(Boolean).join("\n") : "";
const terminalOutput = input?.command
  ? `$ ${input.command}${outputText ? `\n${outputText}` : ""}`
  : outputText;
```

and change the render condition `input?.command || output` to `input?.command || outputText`.

- [ ] **Step 2: read-tool.tsx — render the text arm's file content**

Replace `const code = output?.replace(/^\s*(\d+)→/gm, "");` with:

```ts
const code = output?.type === "text" ? output.file.content : undefined;
```

(The structured content has no line-number prefixes — the regex strip is obsolete.)

- [ ] **Step 3: glob-tool.tsx — render filenames**

Replace the output render block:

```tsx
{
  output ? (
    <CodeBlock code={output.filenames.join("\n")} language="text" className="text-sm" />
  ) : null;
}
```

- [ ] **Step 4: grep-tool.tsx — render content or filenames**

```tsx
{
  output ? (
    <CodeBlock
      code={output.content ?? output.filenames.join("\n")}
      language="text"
      className="text-sm"
    />
  ) : null;
}
```

- [ ] **Step 5: web-fetch-tool.tsx — render result**

Replace `{output ? (...) <Response>{output}</Response> ...}` inner value with `<Response>{output.result}</Response>` (same surrounding block).

- [ ] **Step 6: web-search-tool.tsx — render hits and commentary**

Replace `<ToolContent>{output ? <Response>{output}</Response> : null}</ToolContent>` with:

```tsx
<ToolContent>
  {output?.results.map((result, index) =>
    typeof result === "string" ? (
      <Response key={index}>{result}</Response>
    ) : (
      <ul key={index} className="space-y-1 text-sm">
        {result.content.map((hit) => (
          <li key={hit.url}>
            <a href={hit.url} target="_blank" rel="noreferrer" className="underline">
              {hit.title}
            </a>
          </li>
        ))}
      </ul>
    ),
  )}
</ToolContent>
```

- [ ] **Step 7: task-tool.tsx — output is AgentOutput, not a block array**

Replace the `Array.isArray(output) ? output.map(...)` block with:

```tsx
{
  output && "content" in output
    ? output.content.map((part) =>
        part.type === "text" ? (
          <div key={part.text}>
            <Response>{part.text}</Response>
          </div>
        ) : null,
      )
    : null;
}
```

- [ ] **Step 8: Workspace check + build**

Run: `vp check && vp run -r build && vp test run`
Expected: all PASS across the workspace.

- [ ] **Step 9: Commit**

```bash
git add -A packages/ui
git commit -m "feat(ui): render structured tool_use_result outputs in claude-code tools"
```

---

### Task 7: End-to-end verification

- [ ] **Step 1: Full gates**

Run: `vp check && vp test run && vp run -r build`
Expected: all PASS.

- [ ] **Step 2: Live smoke (requires ANTHROPIC auth on this machine)**

Start the dev flow per `packages/vibest` / `apps/web` README (dev server in background), open the web chat, send: `read the file package.json then run echo hello`. Verify in the UI: the Read tool card shows the real file content (structured, no `1→` line-number artifacts), the Bash tool card shows `$ echo hello` + `hello`, and the conversation finishes cleanly. If no auth is available, record the smoke as skipped in the final report — do not fake it.

- [ ] **Step 3: Commit any leftover fixups; hand off**

Use superpowers:finishing-a-development-branch.
