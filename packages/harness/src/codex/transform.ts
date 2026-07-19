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
//   • non-streamed items (plan/hookPrompt/review/compaction/…) → skipped; no
//     `data-*` parts on the chunk track.
//   • turn lifecycle → `start`/`finish`/`error`.

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
      case "userMessage": // the echo of our own turn input
      case "plan":
      case "hookPrompt":
      case "enteredReviewMode":
      case "exitedReviewMode":
      case "contextCompaction":
      case "sleep":
      case "subAgentActivity":
        // skip — no data-* parts on the chunk track.
        break;
      default:
        // Exhaustive: a new ThreadItem arm must be routed (or skipped) here.
        void (item satisfies never);
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

      case "turn/completed":
        yield { type: "finish" };
        break;

      case "error":
        yield { type: "error", errorText: notification.params.error.message };
        // A retryable error keeps the turn open; a terminal one ends the message.
        if (!notification.params.willRetry) yield { type: "finish" };
        break;

      // Everything else is either a session-layer event (see to-session-event)
      // or out of scope for the chunk track. The satisfies keeps the skip-list
      // explicit: a new notification method fails typecheck until routed or listed.
      default:
        void (notification.method satisfies
          // item-level increments — the terminal item/completed snapshot covers them
          | "item/plan/delta"
          | "item/commandExecution/outputDelta"
          | "item/commandExecution/terminalInteraction"
          | "item/fileChange/outputDelta"
          | "item/fileChange/patchUpdated"
          | "item/mcpToolCall/progress"
          | "item/reasoning/summaryPartAdded"
          | "item/autoApprovalReview/started"
          | "item/autoApprovalReview/completed"
          | "rawResponseItem/completed"
          // turn-level side channels
          | "turn/diff/updated"
          | "turn/plan/updated"
          | "turn/moderationMetadata"
          | "hook/started"
          | "hook/completed"
          // thread / session layer
          | "thread/started"
          | "thread/status/changed"
          | "thread/archived"
          | "thread/unarchived"
          | "thread/deleted"
          | "thread/closed"
          | "thread/name/updated"
          | "thread/goal/updated"
          | "thread/goal/cleared"
          | "thread/settings/updated"
          | "thread/tokenUsage/updated"
          | "thread/compacted"
          | "skills/changed"
          // realtime voice
          | "thread/realtime/started"
          | "thread/realtime/itemAdded"
          | "thread/realtime/transcript/delta"
          | "thread/realtime/transcript/done"
          | "thread/realtime/outputAudio/delta"
          | "thread/realtime/sdp"
          | "thread/realtime/error"
          | "thread/realtime/closed"
          // process / exec plumbing
          | "command/exec/outputDelta"
          | "process/outputDelta"
          | "process/exited"
          // account / app / infra
          | "account/updated"
          | "account/rateLimits/updated"
          | "account/login/completed"
          | "app/list/updated"
          | "remoteControl/status/changed"
          | "externalAgentConfig/import/progress"
          | "externalAgentConfig/import/completed"
          | "fs/changed"
          | "serverRequest/resolved"
          | "mcpServer/oauthLogin/completed"
          | "mcpServer/startupStatus/updated"
          | "model/rerouted"
          | "model/verification"
          | "model/safetyBuffering/updated"
          // warnings / notices
          | "warning"
          | "guardianWarning"
          | "deprecationNotice"
          | "configWarning"
          // fuzzy file search
          | "fuzzyFileSearch/sessionUpdated"
          | "fuzzyFileSearch/sessionCompleted"
          // windows
          | "windows/worldWritableWarning"
          | "windowsSandbox/setupCompleted");
    }
  };
}
