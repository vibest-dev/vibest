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
    expectTypeOf<In<"ReportFindings">>().toEqualTypeOf<st.ReportFindingsInput>();
    expectTypeOf<In<"Workflow">>().toEqualTypeOf<st.WorkflowInput>();
    expectTypeOf<In<"ScheduleWakeup">>().toEqualTypeOf<st.ScheduleWakeupInput>();
    expectTypeOf<In<"Monitor">>().toEqualTypeOf<st.MonitorInput>();
    expectTypeOf<In<"CronCreate">>().toEqualTypeOf<st.CronCreateInput>();
    expectTypeOf<In<"CronDelete">>().toEqualTypeOf<st.CronDeleteInput>();
    expectTypeOf<In<"CronList">>().toEqualTypeOf<st.CronListInput>();
    expectTypeOf<In<"RemoteTrigger">>().toEqualTypeOf<st.RemoteTriggerInput>();
    expectTypeOf<In<"PushNotification">>().toEqualTypeOf<st.PushNotificationInput>();
    expectTypeOf<In<"ListMcpResourcesTool">>().toEqualTypeOf<st.ListMcpResourcesInput>();
    expectTypeOf<In<"ReadMcpResourceTool">>().toEqualTypeOf<st.ReadMcpResourceInput>();
    expectTypeOf<In<"ReadMcpResourceDirTool">>().toEqualTypeOf<st.ReadMcpResourceDirInput>();
    expectTypeOf<In<"DesignSync">>().toEqualTypeOf<st.ClaudeDesignInput>();
    expectTypeOf<In<"Artifact">>().toEqualTypeOf<st.ArtifactInput>();
    expectTypeOf<In<"REPL">>().toEqualTypeOf<st.REPLInput>();
    expectTypeOf<In<"Projects">>().toEqualTypeOf<st.ProjectsInput>();
    expectTypeOf<
      In<"ShowOnboardingRolePicker">
    >().toEqualTypeOf<st.ShowOnboardingRolePickerInput>();
    expectTypeOf<In<"RefreshMcpTools">>().toEqualTypeOf<st.RefreshMcpToolsInput>();
    expectTypeOf<In<"SendFeedback">>().toEqualTypeOf<st.SendFeedbackInput>();
    expectTypeOf<In<"propose_skills">>().toEqualTypeOf<st.ProposeSkillsInput>();
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
    expectTypeOf<Out<"ReportFindings">>().toEqualTypeOf<st.ReportFindingsOutput>();
    expectTypeOf<Out<"Workflow">>().toEqualTypeOf<st.WorkflowOutput>();
    expectTypeOf<Out<"ScheduleWakeup">>().toEqualTypeOf<st.ScheduleWakeupOutput>();
    expectTypeOf<Out<"Monitor">>().toEqualTypeOf<st.MonitorOutput>();
    expectTypeOf<Out<"CronCreate">>().toEqualTypeOf<st.CronCreateOutput>();
    expectTypeOf<Out<"CronDelete">>().toEqualTypeOf<st.CronDeleteOutput>();
    expectTypeOf<Out<"CronList">>().toEqualTypeOf<st.CronListOutput>();
    expectTypeOf<Out<"RemoteTrigger">>().toEqualTypeOf<st.RemoteTriggerOutput>();
    expectTypeOf<Out<"PushNotification">>().toEqualTypeOf<st.PushNotificationOutput>();
    expectTypeOf<Out<"ListMcpResourcesTool">>().toEqualTypeOf<st.ListMcpResourcesOutput>();
    expectTypeOf<Out<"ReadMcpResourceTool">>().toEqualTypeOf<st.ReadMcpResourceOutput>();
    expectTypeOf<Out<"ReadMcpResourceDirTool">>().toEqualTypeOf<st.ReadMcpResourceDirOutput>();
    expectTypeOf<Out<"DesignSync">>().toEqualTypeOf<st.ClaudeDesignOutput>();
    expectTypeOf<Out<"Artifact">>().toEqualTypeOf<st.ArtifactOutput>();
    expectTypeOf<Out<"REPL">>().toEqualTypeOf<st.REPLOutput>();
    expectTypeOf<Out<"Projects">>().toEqualTypeOf<st.ProjectsOutput>();
    expectTypeOf<
      Out<"ShowOnboardingRolePicker">
    >().toEqualTypeOf<st.ShowOnboardingRolePickerOutput>();
    expectTypeOf<Out<"RefreshMcpTools">>().toEqualTypeOf<st.RefreshMcpToolsOutput>();
    expectTypeOf<Out<"SendFeedback">>().toEqualTypeOf<st.SendFeedbackOutput>();
    expectTypeOf<Out<"propose_skills">>().toEqualTypeOf<st.ProposeSkillsOutput>();
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
