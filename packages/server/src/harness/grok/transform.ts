import { isGrokTool, type GrokUIMessageChunk } from "@vibest/contract/grok";
import { v7 as uuid } from "uuid";

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

type SeenTool = {
  readonly toolName: string;
  readonly dynamic: boolean;
};

// ACP session/update → UI-chunk transform. One factory per session; the
// returned generator holds open text/reasoning blocks so deltas and the
// turn-end close agree. Non-render updates (commands, recap, hooks, queue)
// are skipped — no `data-*` parts on the chunk track.

export function createGrokTransform(
  sessionId: string,
): (notification: RpcNotification) => Generator<GrokUIMessageChunk> {
  let turnOpen = false;
  let textOpen = false;
  let reasoningOpen = false;
  const seenTools = new Map<string, SeenTool>();

  function* ensureTurn(): Generator<GrokUIMessageChunk> {
    if (turnOpen) return;
    turnOpen = true;
    yield { type: "start", messageId: uuid(), messageMetadata: { sessionId } };
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
        const toolName = toolNameOf(update["_meta"], update.title);
        const dynamic = isDynamicTool(toolName);
        seenTools.set(toolCallId, { toolName, dynamic });
        yield {
          type: "tool-input-available",
          toolCallId,
          toolName,
          input: update.rawInput ?? {},
          providerExecuted: true,
          dynamic,
        };
        return;
      }
      case "tool_call_update": {
        const toolCallId = update.toolCallId;
        if (typeof toolCallId !== "string") return;
        yield* ensureTurn();
        let seen = seenTools.get(toolCallId);
        if (!seen && update.rawInput !== undefined) {
          const toolName = toolNameOf(update["_meta"], update.title);
          seen = { toolName, dynamic: isDynamicTool(toolName) };
          seenTools.set(toolCallId, seen);
          yield {
            type: "tool-input-available",
            toolCallId,
            toolName,
            input: update.rawInput,
            providerExecuted: true,
            dynamic: seen.dynamic,
          };
        }
        const dynamic = seen?.dynamic ?? true;
        if (update.status === "failed") {
          yield {
            type: "tool-output-error",
            toolCallId,
            errorText: typeof update.rawOutput === "string" ? update.rawOutput : "tool failed",
            dynamic,
          };
          return;
        }
        if (update.status === "completed" || update.rawOutput !== undefined) {
          yield {
            type: "tool-output-available",
            toolCallId,
            output: update.rawOutput ?? {},
            providerExecuted: true,
            dynamic,
          };
        }
        return;
      }
      default:
        return;
    }
  }

  return function* transform(notification: RpcNotification): Generator<GrokUIMessageChunk> {
    if (isSessionUpdate(notification) && notification.params.update) {
      yield* onUpdate(notification.params.update);
      return;
    }
    if (isXaiSessionNotification(notification)) {
      const kind = notification.params.update?.sessionUpdate;
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
