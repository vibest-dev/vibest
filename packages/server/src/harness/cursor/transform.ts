import { isCursorTool, type CursorUIMessageChunk } from "@vibest/contract/cursor";
import { v7 as uuid } from "uuid";

import {
  isSessionUpdate,
  isTurnEnd,
  toolNameOf,
  type AcpSessionUpdate,
  type RpcNotification,
} from "./protocol";

const TEXT_ID = "text";
const REASONING_ID = "reasoning";

const isDynamicTool = (toolName: string): boolean => !isCursorTool(toolName);

type SeenTool = {
  readonly toolName: string;
  readonly dynamic: boolean;
};

export type CursorTransform = {
  readonly apply: (notification: RpcNotification) => Generator<CursorUIMessageChunk>;
  readonly endTurn: () => Generator<CursorUIMessageChunk>;
};

// ACP session/update → UI-chunk transform. One factory per session; the
// returned generators hold open text/reasoning blocks so deltas and the
// turn-end close agree. Cursor ACP has no Grok-style `_x.ai` turn_completed
// notice — the agent injects `endTurn` when `session/prompt` returns.

export function createCursorTransform(sessionId: string): CursorTransform {
  let turnOpen = false;
  let textOpen = false;
  let reasoningOpen = false;
  const seenTools = new Map<string, SeenTool>();

  function* ensureTurn(): Generator<CursorUIMessageChunk> {
    if (turnOpen) return;
    turnOpen = true;
    yield { type: "start", messageId: uuid(), messageMetadata: { sessionId } };
  }

  function* closeBlocks(): Generator<CursorUIMessageChunk> {
    if (textOpen) {
      textOpen = false;
      yield { type: "text-end", id: TEXT_ID };
    }
    if (reasoningOpen) {
      reasoningOpen = false;
      yield { type: "reasoning-end", id: REASONING_ID };
    }
  }

  function* onUpdate(update: AcpSessionUpdate): Generator<CursorUIMessageChunk> {
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
        const toolName = toolNameOf(update);
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
          const toolName = toolNameOf(update);
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

  function* closeAndFinish(): Generator<CursorUIMessageChunk> {
    yield* closeBlocks();
    seenTools.clear();
    if (turnOpen) {
      turnOpen = false;
      yield { type: "finish" };
      return;
    }
    yield { type: "finish" };
  }

  return {
    *apply(notification: RpcNotification): Generator<CursorUIMessageChunk> {
      if (isTurnEnd(notification)) {
        yield* closeAndFinish();
        return;
      }
      if (isSessionUpdate(notification) && notification.params.update) {
        yield* onUpdate(notification.params.update);
      }
    },
    *endTurn(): Generator<CursorUIMessageChunk> {
      yield* closeAndFinish();
    },
  };
}
