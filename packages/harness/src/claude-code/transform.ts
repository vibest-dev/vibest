import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { generateId } from "ai";

import type { ClaudeCodeUIMessageChunk } from "../types/envelope";
import { flattenToolResultText, subagentMetadata } from "./render-policy";
import { claudeCodeTools } from "./tools";

/**
 * Per-session render transform factory. State: each tool call's `dynamic`
 * classification, replayed onto its tool_result (which carries no tool name).
 *
 * Policy (decided 2026-07-12):
 *   • tool output = the structured `tool_use_result`; NO content fallback —
 *     subagent messages omit it, so their output stays undefined.
 *   • tool errors = flattened model-facing content as errorText.
 *   • system/result payloads are NOT forwarded (no `data-*` parts); only the
 *     start/error/finish lifecycle chunks are derived from them.
 */
export function createTransform(): (message: SDKMessage) => Generator<ClaudeCodeUIMessageChunk> {
  const dynamicToolCalls = new Map<string, boolean>();

  return function* transform(message) {
    switch (message.type) {
      case "system": {
        if (message.subtype === "init") yield { type: "start" };
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
