import type { ServerNotification } from "./protocol";
import type { ThreadItem } from "./protocol/v2";
import type { CodexUIMessageChunk } from "./ui-message";

// app-server notification → UI-chunk transform, the codex analog of the Claude
// `createTransform`. Same house generator-factory style: call once per session
// (= per thread); the returned generator holds its open-block state in
// closure variables.
//
// Codex streams *items* (`item/started` → deltas → `item/completed`):
//   • agentMessage → text-*    (delta via item/agentMessage/delta)
//   • reasoning    → reasoning-*(delta via item/reasoning/{textDelta,summaryTextDelta})
//   • tool items   → tool-input-available (on start) + tool-output-available (on
//     complete). The AI-SDK tool chunks are generic (`toolName: string`,
//     `input/output: unknown`), so every tool arm forwards the whole item — the
//     CodexUITools types still discriminate `message.parts` downstream.
//   • bucket-3 items (plan/hookPrompt/review/compaction) → typed `data-*` parts.
//   • turn/thread lifecycle → `start`/`finish` + typed `data-*` parts.

// The item kinds both tracks render as generic `tool-<type>` parts — the LIVE
// transform below and the cold-read mapper (history) must agree on this set,
// so the predicate is shared.
export type ToolThreadItem = Extract<
  ThreadItem,
  {
    type:
      | "commandExecution"
      | "fileChange"
      | "webSearch"
      | "collabAgentToolCall"
      | "imageGeneration"
      | "imageView"
      | "mcpToolCall"
      | "dynamicToolCall";
  }
>;

export function isToolThreadItem(item: ThreadItem): item is ToolThreadItem {
  switch (item.type) {
    case "commandExecution":
    case "fileChange":
    case "webSearch":
    case "collabAgentToolCall":
    case "imageGeneration":
    case "imageView":
    case "mcpToolCall":
    case "dynamicToolCall":
      return true;
    default:
      return false;
  }
}

// MCP tools and other dynamically-registered tool calls have no SDK-typed UI
// tool schema — the renderer routes them to a generic DynamicToolPart instead
// of a typed `tool-<type>` component. Shared between the live transform below
// and the cold-read mapper (history), like `isToolThreadItem`.
export function isDynamicToolThreadItem(item: ToolThreadItem): boolean {
  return item.type === "mcpToolCall" || item.type === "dynamicToolCall";
}

/** A reasoning item's display text: raw content when present, else the summary. */
export function reasoningText(item: Extract<ThreadItem, { type: "reasoning" }>): string {
  return (item.content.length > 0 ? item.content : item.summary).join("");
}

/** Per-session render transform factory: one `createCodexTransform()` call per thread. */
export function createCodexTransform(): (
  notification: ServerNotification,
) => Generator<CodexUIMessageChunk> {
  // Item ids with an open text / reasoning block, so deltas, completion, and the
  // no-delta fallback all agree on whether a `*-start` has already fired.
  const openText = new Set<string>();
  const openReasoning = new Set<string>();

  function* startText(id: string): Generator<CodexUIMessageChunk> {
    if (openText.has(id)) return;
    openText.add(id);
    yield { type: "text-start", id };
  }
  function* startReasoning(id: string): Generator<CodexUIMessageChunk> {
    if (openReasoning.has(id)) return;
    openReasoning.add(id);
    yield { type: "reasoning-start", id };
  }

  function* onItemStart(item: ThreadItem): Generator<CodexUIMessageChunk> {
    // tool calls: emit the call as soon as it's known; the result follows on
    // item/completed. Generic tool chunk, so the whole item flows as `input`.
    if (isToolThreadItem(item)) {
      yield {
        type: "tool-input-available",
        toolCallId: item.id,
        toolName: item.type,
        input: item,
        providerExecuted: true,
        dynamic: isDynamicToolThreadItem(item),
      };
      return;
    }
    switch (item.type) {
      case "agentMessage":
        yield* startText(item.id);
        break;
      case "reasoning":
        yield* startReasoning(item.id);
        break;
      // userMessage (our own echo) + bucket-3 items carry nothing useful at start.
    }
  }

  function* onItemComplete(item: ThreadItem): Generator<CodexUIMessageChunk> {
    if (isToolThreadItem(item)) {
      yield {
        type: "tool-output-available",
        toolCallId: item.id,
        output: item,
        providerExecuted: true,
        dynamic: isDynamicToolThreadItem(item),
      };
      return;
    }
    switch (item.type) {
      case "agentMessage":
        if (openText.delete(item.id)) {
          yield { type: "text-end", id: item.id };
        } else {
          // No deltas streamed for this item — the complete item is the only
          // source, so emit it whole or the text is lost.
          yield { type: "text-start", id: item.id };
          if (item.text) yield { type: "text-delta", id: item.id, delta: item.text };
          yield { type: "text-end", id: item.id };
        }
        break;
      case "reasoning":
        if (openReasoning.delete(item.id)) {
          yield { type: "reasoning-end", id: item.id };
        } else {
          const text = reasoningText(item);
          yield { type: "reasoning-start", id: item.id };
          if (text) yield { type: "reasoning-delta", id: item.id, delta: text };
          yield { type: "reasoning-end", id: item.id };
        }
        break;
      // bucket-3: whole-payload data parts (mirrors how Claude forwards data-*).
      case "plan":
        yield { type: "data-plan", data: item };
        break;
      case "hookPrompt":
        yield { type: "data-hookPrompt", data: item };
        break;
      case "enteredReviewMode":
        yield { type: "data-review/entered", data: item };
        break;
      case "exitedReviewMode":
        yield { type: "data-review/exited", data: item };
        break;
      case "contextCompaction":
        yield { type: "data-compaction", data: item };
        break;
      // userMessage → skip (it's the echo of our own turn input).
    }
  }

  return function* transform(notification: ServerNotification): Generator<CodexUIMessageChunk> {
    switch (notification.method) {
      case "turn/started":
        yield {
          type: "start",
          messageId: notification.params.turn.id,
          messageMetadata: { sessionId: notification.params.threadId },
        };
        break;

      case "item/started":
        yield* onItemStart(notification.params.item);
        break;

      case "item/agentMessage/delta":
        yield* startText(notification.params.itemId);
        yield {
          type: "text-delta",
          id: notification.params.itemId,
          delta: notification.params.delta,
        };
        break;

      // Codex streams a reasoning *summary* (and, when enabled, raw text) — both
      // route to one reasoning block per item.
      case "item/reasoning/textDelta":
      case "item/reasoning/summaryTextDelta":
        yield* startReasoning(notification.params.itemId);
        yield {
          type: "reasoning-delta",
          id: notification.params.itemId,
          delta: notification.params.delta,
        };
        break;

      case "item/completed":
        yield* onItemComplete(notification.params.item);
        break;

      case "thread/started":
        yield { type: "data-thread/started", data: notification.params };
        break;

      case "thread/tokenUsage/updated":
        yield { type: "data-thread/tokenUsage", data: notification.params.tokenUsage };
        break;

      case "turn/completed":
        yield { type: "data-turn/completed", data: notification.params };
        yield { type: "finish" };
        break;

      case "error":
        yield { type: "data-turn/error", data: notification.params.error };
        yield { type: "error", errorText: notification.params.error.message };
        // A retryable error keeps the turn open; a terminal one ends the message.
        if (!notification.params.willRetry) yield { type: "finish" };
        break;

      // Everything else (account/app/fs/mcp/realtime/… notifications) is either a
      // session-layer event (see to-session-event) or out of scope for the chunk track.
    }
  };
}
