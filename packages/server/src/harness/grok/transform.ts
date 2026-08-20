import { grokTools, isGrokTool, type GrokUIMessageChunk } from "@vibest/contract/grok";

import {
  isSessionUpdate,
  isXaiSessionNotification,
  toolNameOf,
  type AcpSessionUpdate,
  type RpcNotification,
} from "./protocol";

const TEXT_ID = "text";
const REASONING_ID = "reasoning";

const isDynamicTool = (toolName: string): boolean =>
  !isGrokTool(toolName) || toolName === "use_tool" || toolName === "search_tool";

// ACP session/update → UI-chunk transform. One factory per session; the
// returned generator holds open text/reasoning blocks so deltas and the
// turn-end close agree. Non-render updates (commands, recap, hooks, queue)
// are skipped — no `data-*` parts on the chunk track.

export function createGrokTransform(): (
  notification: RpcNotification,
) => Generator<GrokUIMessageChunk> {
  let turnOpen = false;
  let textOpen = false;
  let reasoningOpen = false;
  const seenTools = new Set<string>();

  function* ensureTurn(): Generator<GrokUIMessageChunk> {
    if (turnOpen) return;
    turnOpen = true;
    yield { type: "start" };
  }

  function* closeBlocks(): Generator<GrokUIMessageChunk> {
    if (textOpen) {
      textOpen = false;
      yield { type: "text-end", id: TEXT_ID };
    }
    if (reasoningOpen) {
      reasoningOpen = false;
      yield { type: "reasoning-end", id: REASONING_ID };
    }
  }

  function* onUpdate(update: AcpSessionUpdate): Generator<GrokUIMessageChunk> {
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const delta = update.content?.text;
        if (typeof delta !== "string" || delta.length === 0) return;
        yield* ensureTurn();
        if (reasoningOpen) {
          reasoningOpen = false;
          yield { type: "reasoning-end", id: REASONING_ID };
        }
        if (!textOpen) {
          textOpen = true;
          yield { type: "text-start", id: TEXT_ID };
        }
        yield { type: "text-delta", id: TEXT_ID, delta };
        return;
      }
      case "agent_thought_chunk": {
        const delta = update.content?.text;
        if (typeof delta !== "string" || delta.length === 0) return;
        yield* ensureTurn();
        if (!reasoningOpen) {
          reasoningOpen = true;
          yield { type: "reasoning-start", id: REASONING_ID };
        }
        yield { type: "reasoning-delta", id: REASONING_ID, delta };
        return;
      }
      case "tool_call": {
        const toolCallId = update.toolCallId;
        if (typeof toolCallId !== "string") return;
        yield* ensureTurn();
        if (seenTools.has(toolCallId)) return;
        seenTools.add(toolCallId);
        const toolName = toolNameOf(update);
        yield {
          type: "tool-input-available",
          toolCallId,
          toolName,
          input: update.rawInput ?? {},
          providerExecuted: true,
          dynamic: isDynamicTool(toolName) || !(toolName in grokTools),
        };
        return;
      }
      case "tool_call_update": {
        const toolCallId = update.toolCallId;
        if (typeof toolCallId !== "string") return;
        yield* ensureTurn();
        if (!seenTools.has(toolCallId) && update.rawInput !== undefined) {
          seenTools.add(toolCallId);
          const toolName = toolNameOf(update);
          yield {
            type: "tool-input-available",
            toolCallId,
            toolName,
            input: update.rawInput,
            providerExecuted: true,
            dynamic: isDynamicTool(toolName),
          };
        }
        if (update.status === "failed") {
          yield {
            type: "tool-output-error",
            toolCallId,
            errorText: typeof update.rawOutput === "string" ? update.rawOutput : "tool failed",
            dynamic: false,
          };
          return;
        }
        if (update.status === "completed" || update.rawOutput !== undefined) {
          yield {
            type: "tool-output-available",
            toolCallId,
            output: update.rawOutput ?? {},
            providerExecuted: true,
            dynamic: false,
          };
        }
        return;
      }
      default:
        return;
    }
  }

  return function* transform(notification: RpcNotification): Generator<GrokUIMessageChunk> {
    if (isSessionUpdate(notification)) {
      yield* onUpdate(notification.params.update);
      return;
    }
    if (isXaiSessionNotification(notification)) {
      const kind = notification.params.update.sessionUpdate;
      if (kind === "turn_completed") {
        yield* closeBlocks();
        if (turnOpen) {
          turnOpen = false;
          seenTools.clear();
          yield { type: "finish" };
        }
      }
    }
  };
}
