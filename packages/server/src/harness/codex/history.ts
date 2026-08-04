import type { CodexUIMessage } from "@vibest/contract/codex";
import type { ThreadItem, Turn } from "@vibest/contract/codex/protocol/v2";

import { isDynamicToolThreadItem, isToolThreadItem, reasoningText } from "./transform";

// Codex `thread/read` turns → final-form UIMessages, the history counterpart
// of createCodexTransform (same shape convention as claude's
// sessionMessagesToUIMessages and pi's entriesToUIMessages). History is settled
// data, so parts are constructed directly — no chunk replay.
//
// Fold rules:
//   • One assistant message per turn, id = turn.id — the live `start` chunk
//     stamps the same id as messageId, so refreshes reconcile.
//   • A `userMessage` item opens a user message (id = item.id). Mid-turn steer
//     inputs land in item order; the turn's assistant message keeps growing.
//   • Tool items map to the same generic `tool-<type>` / `dynamic-tool` parts
//     as the live transform, with the whole item as both input and output —
//     stored items are terminal snapshots, so the state is `output-available`.
//   • Live parity: the non-streamed item kinds the live transform skips
//     (plan/hookPrompt/review/compaction/…) stay off the transcript here too.

type CodexUIMessagePart = CodexUIMessage["parts"][number];
type CodexToolPart = Extract<CodexUIMessagePart, { type: `tool-${string}` }>;
type CodexDynamicToolPart = Extract<CodexUIMessagePart, { type: "dynamic-tool" }>;

function userParts(item: Extract<ThreadItem, { type: "userMessage" }>): CodexUIMessagePart[] {
  const parts: CodexUIMessagePart[] = [];
  for (const input of item.content) {
    // Text only: the other input kinds (images, skills, mentions) never reach
    // the live stream's user path either, so history stays no richer than live.
    if (input.type === "text" && input.text !== "") {
      parts.push({ type: "text", text: input.text });
    }
  }
  return parts;
}

// The item type arrives as a runtime string, so the correlated `tool-<type>` ×
// input union can't be constructed literally — same convention as the claude
// and pi history folds.
function toolPart(item: ThreadItem & { readonly id: string }): CodexUIMessagePart {
  const settled = {
    toolCallId: item.id,
    state: "output-available" as const,
    input: item,
    output: item,
    providerExecuted: true,
  };
  if (isToolThreadItem(item) && isDynamicToolThreadItem(item)) {
    return { type: "dynamic-tool", toolName: item.type, ...settled } as CodexDynamicToolPart;
  }
  return { type: `tool-${item.type}`, ...settled } as CodexToolPart;
}

/**
 * Fold a codex thread's stored turns into UIMessages.
 *
 * Pure and synchronous; turns arrive in chronological order from
 * `thread/read` with `includeTurns: true`.
 */
export function turnsToUIMessages(turns: ReadonlyArray<Turn>): CodexUIMessage[] {
  const messages: CodexUIMessage[] = [];
  for (const turn of turns) {
    // The turn's assistant message, opened lazily on its first assistant item.
    let assistant: CodexUIMessage | null = null;
    const openAssistant = (): CodexUIMessage => {
      if (assistant === null) {
        assistant = { id: turn.id, role: "assistant", parts: [] };
        messages.push(assistant);
      }
      return assistant;
    };
    for (const item of turn.items) {
      if (item.type === "userMessage") {
        const parts = userParts(item);
        if (parts.length > 0) messages.push({ id: item.id, role: "user", parts });
        continue;
      }
      if (isToolThreadItem(item)) {
        openAssistant().parts.push(toolPart(item));
        continue;
      }
      switch (item.type) {
        case "agentMessage":
          if (item.text !== "") {
            openAssistant().parts.push({ type: "text", text: item.text, state: "done" });
          }
          break;
        case "reasoning": {
          const text = reasoningText(item);
          if (text !== "") {
            openAssistant().parts.push({ type: "reasoning", text, state: "done" });
          }
          break;
        }
        default:
          // plan/hookPrompt/review/compaction/sleep/subAgentActivity — skipped
          // by the live transform, skipped here.
          break;
      }
    }
  }
  return messages;
}
