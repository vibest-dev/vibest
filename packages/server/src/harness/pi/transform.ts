import { v7 as uuid } from "uuid";

import type { AgentSessionEvent } from "./protocol";
import { isDynamicPiTool } from "./tools";
import type { PiUIMessageChunk } from "./ui-message";

// Pi RPC event → UI-chunk transform, the pi analog of createCodexTransform.
// Same house generator-factory style: call once per session; the returned
// generator holds its open-turn state in closure variables.
//
// Pi streams one *run* per prompt (`agent_start` → deltas → `agent_settled`,
// with retries/compaction folded into the same run):
//   • message_update deltas → text-* / reasoning-* (ids are `m<msg>.<block>`;
//     pi content indexes restart per assistant message, so blocks are scoped
//     by a per-run message ordinal)
//   • tool_execution_start/end → tool-input-available + tool-output-available.
//     The AI-SDK tool chunks are generic, so args/results forward whole; the
//     PiTools types still discriminate `message.parts` downstream.
//   • message_end / compaction / auto-retry → skipped; no `data-*` parts on
//     the chunk track
//   • agent_start/agent_settled → `start`/`finish`; a retry re-emits
//     agent_start, so `start` is guarded to fire once per turn.

type AssistantMessage = Extract<
  Extract<AgentSessionEvent, { type: "message_end" }>["message"],
  { role: "assistant" }
>;

/** A tool result's display text: the concatenated text blocks of its content. */
function toolResultText(result: unknown): string {
  const content = (result as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("\n");
}

/** Per-session render transform factory: one `createPiTransform()` call per session. */
export function createPiTransform(
  sessionId: string,
): (event: AgentSessionEvent) => Generator<PiUIMessageChunk> {
  let turnOpen = false;
  // Ordinal of the assistant message within the run; pi's contentIndex restarts
  // per message, so block ids need both to stay unique inside one UIMessage.
  let messageOrdinal = 0;
  // Block ids that streamed at least one delta, so *_end can recover text that
  // only arrived whole (the no-delta fallback, mirroring codex).
  const streamedBlocks = new Set<string>();

  const blockId = (contentIndex: number) => `m${messageOrdinal}.${contentIndex}`;

  function* onAssistantDelta(
    event: Extract<AgentSessionEvent, { type: "message_update" }>,
  ): Generator<PiUIMessageChunk> {
    const delta = event.assistantMessageEvent;
    switch (delta.type) {
      case "start":
        messageOrdinal += 1;
        break;
      case "text_start":
        yield { type: "text-start", id: blockId(delta.contentIndex) };
        break;
      case "text_delta": {
        const id = blockId(delta.contentIndex);
        streamedBlocks.add(id);
        yield { type: "text-delta", id, delta: delta.delta };
        break;
      }
      case "text_end": {
        const id = blockId(delta.contentIndex);
        if (!streamedBlocks.delete(id) && delta.content) {
          yield { type: "text-delta", id, delta: delta.content };
        }
        yield { type: "text-end", id };
        break;
      }
      case "thinking_start":
        yield { type: "reasoning-start", id: blockId(delta.contentIndex) };
        break;
      case "thinking_delta": {
        const id = blockId(delta.contentIndex);
        streamedBlocks.add(id);
        yield { type: "reasoning-delta", id, delta: delta.delta };
        break;
      }
      case "thinking_end": {
        const id = blockId(delta.contentIndex);
        if (!streamedBlocks.delete(id) && delta.content) {
          yield { type: "reasoning-delta", id, delta: delta.content };
        }
        yield { type: "reasoning-end", id };
        break;
      }
      // toolcall_* deltas are skipped: tool_execution_start carries the full
      // args, and the AI-SDK has no incremental tool-output track anyway.
      // done/error are folded into message_end / agent_end.
    }
  }

  return function* transform(event: AgentSessionEvent): Generator<PiUIMessageChunk> {
    switch (event.type) {
      case "agent_start":
        // Retries re-enter the run loop; the turn's UIMessage opens only once.
        if (!turnOpen) {
          turnOpen = true;
          messageOrdinal = 0;
          yield { type: "start", messageId: uuid(), messageMetadata: { sessionId } };
        }
        break;

      case "message_update":
        if (event.message.role === "assistant") yield* onAssistantDelta(event);
        break;

      case "tool_execution_start":
        yield {
          type: "tool-input-available",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          input: event.args,
          providerExecuted: true,
          dynamic: isDynamicPiTool(event.toolName),
        };
        break;

      case "tool_execution_end":
        if (event.isError) {
          yield {
            type: "tool-output-error",
            toolCallId: event.toolCallId,
            errorText: toolResultText(event.result) || "Tool execution failed",
            providerExecuted: true,
            dynamic: isDynamicPiTool(event.toolName),
          };
        } else {
          yield {
            type: "tool-output-available",
            toolCallId: event.toolCallId,
            output: event.result,
            providerExecuted: true,
            dynamic: isDynamicPiTool(event.toolName),
          };
        }
        break;

      case "agent_end": {
        // A model-level failure surfaces as the run's last assistant message
        // with stopReason "error". willRetry keeps the turn open (the retry
        // events follow); the terminal finish always comes from agent_settled.
        const last = event.messages.at(-1) as AssistantMessage | undefined;
        if (last?.role === "assistant" && last.stopReason === "error") {
          yield { type: "error", errorText: last.errorMessage ?? "Pi run failed" };
        }
        break;
      }

      case "agent_settled":
        if (turnOpen) {
          turnOpen = false;
          streamedBlocks.clear();
          yield { type: "finish" };
        }
        break;

      // Everything else is bookkeeping, an echo of our own input, or a payload
      // with no `data-*` part on the chunk track. The satisfies keeps the
      // skip-list explicit: a new AgentSessionEvent arm fails typecheck until
      // it's routed or listed.
      default:
        void (event.type satisfies
          | "message_start"
          | "message_end"
          | "tool_execution_update"
          | "turn_start"
          | "turn_end"
          | "queue_update"
          | "entry_appended"
          | "session_info_changed"
          | "thinking_level_changed"
          | "compaction_start"
          | "compaction_end"
          | "auto_retry_start"
          | "auto_retry_end");
    }
  };
}
