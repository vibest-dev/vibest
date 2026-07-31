import { tool, type InferUITools, type ToolSet, type UIToolInvocation } from "ai";
import { z } from "zod";

import type { ThreadItem } from "./protocol/v2";

/** Pull one `ThreadItem` arm by its discriminant. */
type Item<T extends ThreadItem["type"]> = Extract<ThreadItem, { type: T }>;

export const commandExecution = tool({
  inputSchema:
    z.custom<Pick<Item<"commandExecution">, "command" | "cwd" | "commandActions" | "source">>(),
  outputSchema:
    z.custom<
      Pick<
        Item<"commandExecution">,
        "status" | "aggregatedOutput" | "exitCode" | "durationMs" | "processId"
      >
    >(),
});
export const fileChange = tool({
  inputSchema: z.custom<Pick<Item<"fileChange">, "changes">>(),
  outputSchema: z.custom<Pick<Item<"fileChange">, "status">>(),
});
export const webSearch = tool({
  inputSchema: z.custom<Pick<Item<"webSearch">, "query">>(),
  outputSchema: z.custom<Pick<Item<"webSearch">, "action">>(),
});
export const collabAgentToolCall = tool({
  inputSchema:
    z.custom<
      Pick<
        Item<"collabAgentToolCall">,
        "tool" | "prompt" | "model" | "reasoningEffort" | "senderThreadId"
      >
    >(),
  outputSchema:
    z.custom<Pick<Item<"collabAgentToolCall">, "status" | "receiverThreadIds" | "agentsStates">>(),
});
export const imageGeneration = tool({
  inputSchema: z.custom<Pick<Item<"imageGeneration">, "revisedPrompt">>(),
  outputSchema: z.custom<Pick<Item<"imageGeneration">, "status" | "result" | "savedPath">>(),
});
export const imageView = tool({
  inputSchema: z.custom<Pick<Item<"imageView">, "path">>(),
  outputSchema: z.unknown(),
});

/** Registry of protocol-typed Codex tools. Keys are the wire item-type names. */
export const codexTools = {
  commandExecution,
  fileChange,
  webSearch,
  collabAgentToolCall,
  imageGeneration,
  imageView,
} satisfies ToolSet;

export type CodexTools = InferUITools<typeof codexTools>;

export type CommandExecutionUIToolInvocation = UIToolInvocation<typeof commandExecution>;
export type FileChangeUIToolInvocation = UIToolInvocation<typeof fileChange>;
export type WebSearchUIToolInvocation = UIToolInvocation<typeof webSearch>;
export type CollabAgentToolCallUIToolInvocation = UIToolInvocation<typeof collabAgentToolCall>;
export type ImageGenerationUIToolInvocation = UIToolInvocation<typeof imageGeneration>;
export type ImageViewUIToolInvocation = UIToolInvocation<typeof imageView>;
