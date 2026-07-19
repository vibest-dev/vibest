import type { ToolStateCompleted } from "@opencode-ai/sdk";
import { tool, type InferUITools, type ToolSet } from "ai";
import { z } from "zod";

// Opencode's built-in coding tools. Unlike claude-code/pi, the opencode SDK
// types `ToolPart` generically (`tool: string`, untyped input/metadata), so the
// per-tool input and metadata shapes are transcribed from the opencode source
// (packages/opencode/src/tool/*, v1.18.3 — the version this package pins).
// Keys are the wire tool ids from each `Tool.define(...)` call. Flag-gated
// experimental tools (execute/lsp/plan_exit) and custom/MCP tools are NOT in
// the registry: the transform marks them `dynamic` and the renderer falls back
// to a generic part.

/** A completed tool state with that tool's own metadata shape narrowed. */
type Completed<M> = Omit<ToolStateCompleted, "metadata"> & { metadata: M };

/** `packages/opencode/src/tool/read.ts` `Display`. */
export type OpencodeReadDisplay =
  | {
      type: "directory";
      path: string;
      entries: string[];
      offset: number;
      totalEntries: number;
      truncated: boolean;
    }
  | {
      type: "file";
      path: string;
      text: string;
      lineStart: number;
      lineEnd: number;
      totalLines: number;
      truncated: boolean;
    };

/** `Snapshot.FileDiff` (`@opencode-ai/schema/file-diff`). */
export type OpencodeFileDiff = {
  file?: string;
  patch?: string;
  additions: number;
  deletions: number;
  status?: "added" | "deleted" | "modified";
};

/** LSP diagnostics keyed by file path; entries are vscode-languageserver `Diagnostic`s. */
export type OpencodeDiagnostics = { [file: string]: unknown[] };

export type OpencodeTodo = { content: string; status: string; priority: string };

export type OpencodeQuestionPrompt = {
  question: string;
  header: string;
  options: readonly { label: string; description: string }[];
  multiple?: boolean;
};

export const bash = tool({
  inputSchema: z.custom<{ command: string; timeout?: number; workdir?: string }>(),
  outputSchema:
    z.custom<
      Completed<{ output: string; exit: number | null; truncated: boolean; outputPath?: string }>
    >(),
});
export const read = tool({
  inputSchema: z.custom<{ filePath: string; offset?: number; limit?: number }>(),
  outputSchema: z.custom<
    Completed<{
      preview: string;
      truncated: boolean;
      loaded: string[];
      display?: OpencodeReadDisplay;
    }>
  >(),
});
export const edit = tool({
  inputSchema: z.custom<{
    filePath: string;
    oldString: string;
    newString: string;
    replaceAll?: boolean;
  }>(),
  outputSchema:
    z.custom<
      Completed<{ diagnostics: OpencodeDiagnostics; diff: string; filediff: OpencodeFileDiff }>
    >(),
});
export const write = tool({
  inputSchema: z.custom<{ content: string; filePath: string }>(),
  outputSchema:
    z.custom<Completed<{ diagnostics: OpencodeDiagnostics; filepath: string; exists: boolean }>>(),
});
export const glob = tool({
  inputSchema: z.custom<{ pattern: string; path?: string }>(),
  outputSchema: z.custom<Completed<{ count: number; truncated: boolean }>>(),
});
export const grep = tool({
  inputSchema: z.custom<{ pattern: string; path?: string; include?: string }>(),
  outputSchema: z.custom<Completed<{ matches: number; truncated: boolean }>>(),
});
export const task = tool({
  inputSchema: z.custom<{
    description: string;
    prompt: string;
    subagent_type: string;
    task_id?: string;
    command?: string;
    background?: boolean;
  }>(),
  outputSchema: z.custom<
    Completed<{
      parentSessionId: string;
      sessionId: string;
      model: { modelID: string; providerID: string };
      background?: true;
      /** Only present on background task branches. */
      jobId?: string;
    }>
  >(),
});
export const todowrite = tool({
  inputSchema: z.custom<{ todos: OpencodeTodo[] }>(),
  outputSchema: z.custom<Completed<{ todos: OpencodeTodo[] }>>(),
});
export const webfetch = tool({
  inputSchema: z.custom<{ url: string; format: "text" | "markdown" | "html"; timeout?: number }>(),
  outputSchema: z.custom<Completed<Record<never, never>>>(),
});
export const websearch = tool({
  inputSchema: z.custom<{
    query: string;
    numResults?: number;
    livecrawl?: "fallback" | "preferred";
    type?: "auto" | "fast" | "deep";
    contextMaxCharacters?: number;
  }>(),
  outputSchema: z.custom<Completed<{ provider: "exa" | "parallel" }>>(),
});
export const applyPatch = tool({
  inputSchema: z.custom<{ patchText: string }>(),
  outputSchema: z.custom<
    Completed<{
      diff: string;
      files: {
        filePath: string;
        relativePath: string;
        type: "add" | "update" | "delete" | "move";
        patch: string;
        additions: number;
        deletions: number;
        movePath?: string;
      }[];
      diagnostics: OpencodeDiagnostics;
    }>
  >(),
});
export const question = tool({
  inputSchema: z.custom<{ questions: OpencodeQuestionPrompt[] }>(),
  outputSchema: z.custom<Completed<{ answers: readonly (readonly string[])[] }>>(),
});
export const skill = tool({
  inputSchema: z.custom<{ name: string }>(),
  outputSchema: z.custom<Completed<{ name: string; dir: string }>>(),
});
export const invalid = tool({
  inputSchema: z.custom<{ tool: string; error: string }>(),
  outputSchema: z.custom<Completed<Record<never, never>>>(),
});

/** Registry of opencode's built-in tools. Keys are the wire tool ids. */
export const opencodeTools = {
  bash,
  read,
  edit,
  write,
  glob,
  grep,
  task,
  todowrite,
  webfetch,
  websearch,
  apply_patch: applyPatch,
  question,
  skill,
  invalid,
} satisfies ToolSet;

export type OpencodeTools = InferUITools<typeof opencodeTools>;

/** Anything outside the built-in set (custom/MCP/experimental tools) renders generically. */
export function isDynamicOpencodeTool(toolName: string): boolean {
  return !(toolName in opencodeTools);
}
