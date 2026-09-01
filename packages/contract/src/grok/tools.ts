import { tool, type InferUITools, type ToolSet, type UIToolInvocation } from "ai";
import { z } from "zod";

// Grok built-in tools. Keys are ACP wire names (`title` /
// `_meta["x.ai/tool"].name` on `tool_call` updates). There is no generated SDK
// the way Claude/Codex have, so the input types are the observed `rawInput`
// shapes; `z.custom` is a typed pass-through — the transform forwards input
// and output verbatim and never validates.
//
// MCP invocations arrive as `use_tool` with a nested `tool_name`; they stay
// in the registry so the part is typed, and the UI still renders them with
// the generic card until a dedicated MCP renderer exists.

export type ReadFileInput = {
  readonly target_file: string;
  readonly offset?: number;
  readonly limit?: number;
};
export type SearchReplaceInput = {
  readonly file_path: string;
  readonly old_string: string;
  readonly new_string: string;
};
export type WriteInput = {
  readonly file_path: string;
  readonly content: string;
};
export type RunTerminalCommandInput = {
  readonly command: string;
  readonly description?: string;
};
export type GrepInput = {
  readonly pattern: string;
  readonly path?: string;
  readonly glob?: string;
  readonly head_limit?: number;
};
export type ListDirInput = {
  readonly target_directory: string;
};
export type TodoItem = {
  readonly id: string;
  readonly content: string;
  readonly status: string;
};
export type TodoWriteInput = {
  readonly todos: ReadonlyArray<TodoItem>;
};
export type WebSearchInput = {
  readonly query?: string;
  readonly variant?: string;
  readonly backend?: boolean;
};
export type WebFetchInput = {
  readonly url: string;
};
export type SpawnSubagentInput = {
  readonly description?: string;
  readonly prompt?: string;
  readonly subagent_type?: string;
};
export type GetCommandOrSubagentOutputInput = {
  readonly task_ids: ReadonlyArray<string>;
  readonly timeout_ms?: number;
};
export type UseToolInput = {
  readonly tool_name: string;
  readonly tool_input: Record<string, unknown>;
};
export type SearchToolInput = {
  readonly query: string;
};

export const read_file = tool({
  inputSchema: z.custom<ReadFileInput>(),
  outputSchema: z.unknown(),
});
export const search_replace = tool({
  inputSchema: z.custom<SearchReplaceInput>(),
  outputSchema: z.unknown(),
});
export const write = tool({
  inputSchema: z.custom<WriteInput>(),
  outputSchema: z.unknown(),
});
export const run_terminal_command = tool({
  inputSchema: z.custom<RunTerminalCommandInput>(),
  outputSchema: z.unknown(),
});
export const grep = tool({
  inputSchema: z.custom<GrepInput>(),
  outputSchema: z.unknown(),
});
export const list_dir = tool({
  inputSchema: z.custom<ListDirInput>(),
  outputSchema: z.unknown(),
});
export const todo_write = tool({
  inputSchema: z.custom<TodoWriteInput>(),
  outputSchema: z.unknown(),
});
export const web_search = tool({
  inputSchema: z.custom<WebSearchInput>(),
  outputSchema: z.unknown(),
});
export const web_fetch = tool({
  inputSchema: z.custom<WebFetchInput>(),
  outputSchema: z.unknown(),
});
export const spawn_subagent = tool({
  inputSchema: z.custom<SpawnSubagentInput>(),
  outputSchema: z.unknown(),
});
export const get_command_or_subagent_output = tool({
  inputSchema: z.custom<GetCommandOrSubagentOutputInput>(),
  outputSchema: z.unknown(),
});
export const use_tool = tool({
  inputSchema: z.custom<UseToolInput>(),
  outputSchema: z.unknown(),
});
export const search_tool = tool({
  inputSchema: z.custom<SearchToolInput>(),
  outputSchema: z.unknown(),
});

export const grokTools = {
  read_file,
  search_replace,
  write,
  run_terminal_command,
  grep,
  list_dir,
  todo_write,
  web_search,
  web_fetch,
  spawn_subagent,
  get_command_or_subagent_output,
  use_tool,
  search_tool,
} satisfies ToolSet;

export type GrokTools = InferUITools<typeof grokTools>;

export type ReadFileUIToolInvocation = UIToolInvocation<typeof read_file>;
export type SearchReplaceUIToolInvocation = UIToolInvocation<typeof search_replace>;
export type WriteUIToolInvocation = UIToolInvocation<typeof write>;
export type RunTerminalCommandUIToolInvocation = UIToolInvocation<typeof run_terminal_command>;
export type GrepUIToolInvocation = UIToolInvocation<typeof grep>;
export type ListDirUIToolInvocation = UIToolInvocation<typeof list_dir>;
export type TodoWriteUIToolInvocation = UIToolInvocation<typeof todo_write>;
export type WebSearchUIToolInvocation = UIToolInvocation<typeof web_search>;
export type WebFetchUIToolInvocation = UIToolInvocation<typeof web_fetch>;
export type SpawnSubagentUIToolInvocation = UIToolInvocation<typeof spawn_subagent>;
export type GetCommandOrSubagentOutputUIToolInvocation = UIToolInvocation<
  typeof get_command_or_subagent_output
>;
export type UseToolUIToolInvocation = UIToolInvocation<typeof use_tool>;
export type SearchToolUIToolInvocation = UIToolInvocation<typeof search_tool>;

export function isGrokTool(toolName: string): toolName is keyof typeof grokTools {
  return toolName in grokTools;
}
