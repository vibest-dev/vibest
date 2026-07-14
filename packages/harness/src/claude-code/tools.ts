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
export type MultiEditUIToolInvocation = UIToolInvocation<typeof MultiEdit>;
export type SlashCommandUIToolInvocation = UIToolInvocation<typeof SlashCommand>;
export type BashOutputUIToolInvocation = UIToolInvocation<typeof BashOutput>;
export type KillShellUIToolInvocation = UIToolInvocation<typeof KillShell>;
