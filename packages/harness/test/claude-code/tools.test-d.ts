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
