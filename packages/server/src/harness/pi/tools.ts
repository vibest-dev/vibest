import type {
  AgentToolResult,
  BashToolDetails,
  BashToolInput,
  EditToolDetails,
  EditToolInput,
  FindToolDetails,
  FindToolInput,
  GrepToolDetails,
  GrepToolInput,
  LsToolDetails,
  LsToolInput,
  ReadToolDetails,
  ReadToolInput,
  WriteToolInput,
} from "@earendil-works/pi-coding-agent";
import { tool, type InferUITools, type ToolSet } from "ai";
import { z } from "zod";

// Pi's built-in coding tools, typed straight off the published package (the pi
// analog of codex/tools.ts). Keys are pi's wire tool names as they appear in
// tool_execution_* events. Extension/custom tools have no schema here — the
// transform marks them `dynamic` and the renderer falls back to a generic part.

export const read = tool({
  inputSchema: z.custom<ReadToolInput>(),
  outputSchema: z.custom<AgentToolResult<ReadToolDetails>>(),
});
export const bash = tool({
  inputSchema: z.custom<BashToolInput>(),
  outputSchema: z.custom<AgentToolResult<BashToolDetails>>(),
});
export const edit = tool({
  inputSchema: z.custom<EditToolInput>(),
  outputSchema: z.custom<AgentToolResult<EditToolDetails>>(),
});
export const write = tool({
  inputSchema: z.custom<WriteToolInput>(),
  outputSchema: z.custom<AgentToolResult<undefined>>(),
});
export const grep = tool({
  inputSchema: z.custom<GrepToolInput>(),
  outputSchema: z.custom<AgentToolResult<GrepToolDetails>>(),
});
export const find = tool({
  inputSchema: z.custom<FindToolInput>(),
  outputSchema: z.custom<AgentToolResult<FindToolDetails>>(),
});
export const ls = tool({
  inputSchema: z.custom<LsToolInput>(),
  outputSchema: z.custom<AgentToolResult<LsToolDetails>>(),
});

/** Registry of pi's built-in tools. Keys are the wire tool names. */
export const piTools = { read, bash, edit, write, grep, find, ls } satisfies ToolSet;

export type PiTools = InferUITools<typeof piTools>;

/** Anything outside the built-in set (extension/custom tools) renders generically. */
export function isDynamicPiTool(toolName: string): boolean {
  return !(toolName in piTools);
}
