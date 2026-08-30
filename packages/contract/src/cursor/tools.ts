import { tool, type InferUITools, type ToolSet, type UIToolInvocation } from "ai";
import { z } from "zod";

// Cursor ACP built-in tools. Keys are the wire `title` values on
// `session/update` `tool_call` frames (`Read`, `Shell`, `Write`, …).
// Input types are observed `rawInput` shapes; `z.custom` is a typed
// pass-through — the transform forwards input and output verbatim and never
// validates.
//
// MCP and unrecognized titles stay off this registry so the part is typed as
// dynamic and the UI renders them with the generic card.

export type ReadInput = {
  readonly path?: string;
  readonly offset?: number;
  readonly limit?: number;
};
export type WriteInput = {
  readonly path?: string;
  readonly contents?: string;
};
export type StrReplaceInput = {
  readonly path?: string;
  readonly old_string?: string;
  readonly new_string?: string;
};
export type DeleteInput = {
  readonly path?: string;
};
export type ShellInput = {
  readonly command?: string;
  readonly working_directory?: string;
  readonly block_until_ms?: number;
};
export type GrepInput = {
  readonly pattern?: string;
  readonly path?: string;
  readonly glob?: string;
};
export type GlobInput = {
  readonly glob_pattern?: string;
  readonly target_directory?: string;
};
export type WebSearchInput = {
  readonly search_term?: string;
  readonly explanation?: string;
};
export type WebFetchInput = {
  readonly url?: string;
};
export type TaskInput = {
  readonly description?: string;
  readonly prompt?: string;
};

export const Read = tool({
  inputSchema: z.custom<ReadInput>(),
  outputSchema: z.unknown(),
});
export const Write = tool({
  inputSchema: z.custom<WriteInput>(),
  outputSchema: z.unknown(),
});
export const StrReplace = tool({
  inputSchema: z.custom<StrReplaceInput>(),
  outputSchema: z.unknown(),
});
export const Delete = tool({
  inputSchema: z.custom<DeleteInput>(),
  outputSchema: z.unknown(),
});
export const Shell = tool({
  inputSchema: z.custom<ShellInput>(),
  outputSchema: z.unknown(),
});
export const Grep = tool({
  inputSchema: z.custom<GrepInput>(),
  outputSchema: z.unknown(),
});
export const Glob = tool({
  inputSchema: z.custom<GlobInput>(),
  outputSchema: z.unknown(),
});
export const WebSearch = tool({
  inputSchema: z.custom<WebSearchInput>(),
  outputSchema: z.unknown(),
});
export const WebFetch = tool({
  inputSchema: z.custom<WebFetchInput>(),
  outputSchema: z.unknown(),
});
export const Task = tool({
  inputSchema: z.custom<TaskInput>(),
  outputSchema: z.unknown(),
});

export const cursorTools = {
  Read,
  Write,
  StrReplace,
  Delete,
  Shell,
  Grep,
  Glob,
  WebSearch,
  WebFetch,
  Task,
} satisfies ToolSet;

export type CursorTools = InferUITools<typeof cursorTools>;

export type ReadUIToolInvocation = UIToolInvocation<typeof Read>;
export type WriteUIToolInvocation = UIToolInvocation<typeof Write>;
export type StrReplaceUIToolInvocation = UIToolInvocation<typeof StrReplace>;
export type DeleteUIToolInvocation = UIToolInvocation<typeof Delete>;
export type ShellUIToolInvocation = UIToolInvocation<typeof Shell>;
export type GrepUIToolInvocation = UIToolInvocation<typeof Grep>;
export type GlobUIToolInvocation = UIToolInvocation<typeof Glob>;
export type WebSearchUIToolInvocation = UIToolInvocation<typeof WebSearch>;
export type WebFetchUIToolInvocation = UIToolInvocation<typeof WebFetch>;
export type TaskUIToolInvocation = UIToolInvocation<typeof Task>;

export function isCursorTool(toolName: string): toolName is keyof typeof cursorTools {
  return toolName in cursorTools;
}
