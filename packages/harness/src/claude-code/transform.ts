import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { generateId } from "ai";

import type { ClaudeCodeUIMessageChunk } from "../types/envelope";

/** Map ONE native claude-code message to zero or more render chunks. */
export function* transform(message: SDKMessage): Generator<ClaudeCodeUIMessageChunk> {
  switch (message.type) {
    case "system": {
      if (message.subtype === "init") yield { type: "start" };
      return;
    }
    case "assistant": {
      for (const part of message.message.content) {
        if (part.type === "text") {
          yield { type: "text-start", id: message.message.id };
          yield { type: "text-delta", id: message.message.id, delta: part.text };
          yield { type: "text-end", id: message.message.id };
        } else if (part.type === "tool_use") {
          yield {
            type: "tool-input-available",
            toolCallId: part.id,
            toolName: part.name,
            input: part.input,
            providerExecuted: true,
            providerMetadata: message.parent_tool_use_id
              ? { claudeCode: { parentToolUseId: message.parent_tool_use_id } }
              : undefined,
          };
        }
      }
      return;
    }
    case "user": {
      if (typeof message.message.content === "string") {
        const id = generateId();
        yield { type: "text-start", id };
        yield { type: "text-delta", id, delta: message.message.content };
        yield { type: "text-end", id };
        return;
      }
      for (const part of message.message.content) {
        if (part.type !== "tool_result") continue;
        const providerMetadata = message.parent_tool_use_id
          ? { claudeCode: { parentToolUseId: message.parent_tool_use_id } }
          : undefined;
        if (part.is_error) {
          yield {
            type: "tool-output-error",
            toolCallId: part.tool_use_id,
            errorText: typeof part.content === "string" ? part.content : "",
            providerExecuted: true,
            providerMetadata,
          };
        } else {
          yield {
            type: "tool-output-available",
            toolCallId: part.tool_use_id,
            output: part.content,
            providerExecuted: true,
            providerMetadata,
          };
        }
      }
      return;
    }
    case "result": {
      if (message.subtype === "success") yield { type: "finish" };
      return;
    }
  }
}
