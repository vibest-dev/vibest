import type * as st from "@anthropic-ai/claude-agent-sdk/sdk-tools";
import { tool, type InferUITools, type ToolSet, type UIToolInvocation } from "ai";
import { z } from "zod";

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
// exports no type for (ToolSearch/Skill/SendMessage/…) are NOT in the registry:
// the transform flags them `dynamic` and the UI renders them generically. MCP
// tools stay dynamic too — the SDK types them (`McpInput`/`McpOutput`) but their
// wire names (`mcp__<server>__<tool>`) are per-server, so no fixed key exists.
//
// Wire names that differ from the SDK type names were verified against the CLI
// binary's own name map: FileRead→Read, ClaudeDesign→DesignSync,
// ListMcpResources→ListMcpResourcesTool, ReadMcpResource(Dir)→ReadMcpResource(Dir)Tool,
// ProposeSkills→propose_skills (the only snake_case wire name). The registry ↔
// SDK name map is enforced by the source-text guard in tools-registry.test.ts.

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
export const ReportFindings = tool({
  inputSchema: z.custom<st.ReportFindingsInput>(),
  outputSchema: z.custom<st.ReportFindingsOutput>(),
});
export const Workflow = tool({
  inputSchema: z.custom<st.WorkflowInput>(),
  outputSchema: z.custom<st.WorkflowOutput>(),
});
export const ScheduleWakeup = tool({
  inputSchema: z.custom<st.ScheduleWakeupInput>(),
  outputSchema: z.custom<st.ScheduleWakeupOutput>(),
});
export const Monitor = tool({
  inputSchema: z.custom<st.MonitorInput>(),
  outputSchema: z.custom<st.MonitorOutput>(),
});
export const CronCreate = tool({
  inputSchema: z.custom<st.CronCreateInput>(),
  outputSchema: z.custom<st.CronCreateOutput>(),
});
export const CronDelete = tool({
  inputSchema: z.custom<st.CronDeleteInput>(),
  outputSchema: z.custom<st.CronDeleteOutput>(),
});
export const CronList = tool({
  inputSchema: z.custom<st.CronListInput>(),
  outputSchema: z.custom<st.CronListOutput>(),
});
export const RemoteTrigger = tool({
  inputSchema: z.custom<st.RemoteTriggerInput>(),
  outputSchema: z.custom<st.RemoteTriggerOutput>(),
});
export const PushNotification = tool({
  inputSchema: z.custom<st.PushNotificationInput>(),
  outputSchema: z.custom<st.PushNotificationOutput>(),
});
export const ListMcpResourcesTool = tool({
  inputSchema: z.custom<st.ListMcpResourcesInput>(),
  outputSchema: z.custom<st.ListMcpResourcesOutput>(),
}); // SDK: ListMcpResources
export const ReadMcpResourceTool = tool({
  inputSchema: z.custom<st.ReadMcpResourceInput>(),
  outputSchema: z.custom<st.ReadMcpResourceOutput>(),
}); // SDK: ReadMcpResource
export const ReadMcpResourceDirTool = tool({
  inputSchema: z.custom<st.ReadMcpResourceDirInput>(),
  outputSchema: z.custom<st.ReadMcpResourceDirOutput>(),
}); // SDK: ReadMcpResourceDir
export const DesignSync = tool({
  inputSchema: z.custom<st.ClaudeDesignInput>(),
  outputSchema: z.custom<st.ClaudeDesignOutput>(),
}); // SDK: ClaudeDesign
export const Artifact = tool({
  inputSchema: z.custom<st.ArtifactInput>(),
  outputSchema: z.custom<st.ArtifactOutput>(),
});
export const REPL = tool({
  inputSchema: z.custom<st.REPLInput>(),
  outputSchema: z.custom<st.REPLOutput>(),
});
export const Projects = tool({
  inputSchema: z.custom<st.ProjectsInput>(),
  outputSchema: z.custom<st.ProjectsOutput>(),
});
export const ShowOnboardingRolePicker = tool({
  inputSchema: z.custom<st.ShowOnboardingRolePickerInput>(),
  outputSchema: z.custom<st.ShowOnboardingRolePickerOutput>(),
});
export const RefreshMcpTools = tool({
  inputSchema: z.custom<st.RefreshMcpToolsInput>(),
  outputSchema: z.custom<st.RefreshMcpToolsOutput>(),
});
export const SendFeedback = tool({
  inputSchema: z.custom<st.SendFeedbackInput>(),
  outputSchema: z.custom<st.SendFeedbackOutput>(),
});
export const ProposeSkills = tool({
  inputSchema: z.custom<st.ProposeSkillsInput>(),
  outputSchema: z.custom<st.ProposeSkillsOutput>(),
}); // wire name: propose_skills (the sole snake_case tool)

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
  ReportFindings,
  Workflow,
  ScheduleWakeup,
  Monitor,
  CronCreate,
  CronDelete,
  CronList,
  RemoteTrigger,
  PushNotification,
  ListMcpResourcesTool,
  ReadMcpResourceTool,
  ReadMcpResourceDirTool,
  DesignSync,
  Artifact,
  REPL,
  Projects,
  ShowOnboardingRolePicker,
  RefreshMcpTools,
  SendFeedback,
  propose_skills: ProposeSkills, // wire name is snake_case (verified in CLI binary)
} satisfies ToolSet;

/** Discriminated UI tool union, keyed `tool-Bash` | `tool-Read` | … */
export type ClaudeCodeTools = InferUITools<typeof claudeCodeTools>;

export type BashUIToolInvocation = UIToolInvocation<typeof Bash>;
export type ReadUIToolInvocation = UIToolInvocation<typeof Read>;
export type EditUIToolInvocation = UIToolInvocation<typeof Edit>;
export type WriteUIToolInvocation = UIToolInvocation<typeof Write>;
export type GlobUIToolInvocation = UIToolInvocation<typeof Glob>;
export type GrepUIToolInvocation = UIToolInvocation<typeof Grep>;
export type AgentUIToolInvocation = UIToolInvocation<typeof Agent>;
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
export type ReportFindingsUIToolInvocation = UIToolInvocation<typeof ReportFindings>;
export type WorkflowUIToolInvocation = UIToolInvocation<typeof Workflow>;
export type ScheduleWakeupUIToolInvocation = UIToolInvocation<typeof ScheduleWakeup>;
export type MonitorUIToolInvocation = UIToolInvocation<typeof Monitor>;
export type CronCreateUIToolInvocation = UIToolInvocation<typeof CronCreate>;
export type CronDeleteUIToolInvocation = UIToolInvocation<typeof CronDelete>;
export type CronListUIToolInvocation = UIToolInvocation<typeof CronList>;
export type RemoteTriggerUIToolInvocation = UIToolInvocation<typeof RemoteTrigger>;
export type PushNotificationUIToolInvocation = UIToolInvocation<typeof PushNotification>;
export type ListMcpResourcesToolUIToolInvocation = UIToolInvocation<typeof ListMcpResourcesTool>;
export type ReadMcpResourceToolUIToolInvocation = UIToolInvocation<typeof ReadMcpResourceTool>;
export type ReadMcpResourceDirToolUIToolInvocation = UIToolInvocation<
  typeof ReadMcpResourceDirTool
>;
export type DesignSyncUIToolInvocation = UIToolInvocation<typeof DesignSync>;
export type ArtifactUIToolInvocation = UIToolInvocation<typeof Artifact>;
export type REPLUIToolInvocation = UIToolInvocation<typeof REPL>;
export type ProjectsUIToolInvocation = UIToolInvocation<typeof Projects>;
export type ShowOnboardingRolePickerUIToolInvocation = UIToolInvocation<
  typeof ShowOnboardingRolePicker
>;
export type RefreshMcpToolsUIToolInvocation = UIToolInvocation<typeof RefreshMcpTools>;
export type SendFeedbackUIToolInvocation = UIToolInvocation<typeof SendFeedback>;
export type ProposeSkillsUIToolInvocation = UIToolInvocation<typeof ProposeSkills>;
