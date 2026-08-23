import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { claudeCodeTools, type ClaudeCodeUIMessage } from "@vibest/contract/claude-code";

import { flattenToolResultText, subagentMetadata } from "./render-policy";

// Claude session-file records → final-form UIMessages, the history counterpart
// of createTransform (same shape convention as pi's entriesToUIMessages).
// History is settled data, so parts are constructed directly — no chunk
// replay, no stream machinery. `SessionMessage` stops here: callers only ever
// see `ClaudeCodeUIMessage[]`.
//
// Fold rules:
//   • Segmentation is by user record: a real user input opens a new user
//     message, and the following run of assistant / tool-result records folds
//     into ONE assistant message — mirroring the live stream, where one
//     prompt-run is one UIMessage (`start` at init, `finish` at result).
//   • messageId: the record's `uuid` (user message), or the segment's first
//     assistant record uuid — stable across reads, so refreshes reconcile.
//   • Live parity choices: thinking blocks are not forwarded (the live
//     transform drops them), and successful tool results carry no structured
//     output (`tool_use_result` is not part of `SessionMessage`), which is
//     exactly the shape live subagent results have — renderers handle it.
//   • Slash-command bookkeeping (`<command-name>`, `<local-command-stdout>`,
//     caveat banners) rides the file as user records; it never reaches the
//     live stream, so it is dropped here too.
//   • Trimming the active turn is the caller's job (the facade drops the last
//     user segment while a turn runs); this function maps everything given.
//
// Records arrive in file order from `parseTranscriptRecords` (our own read),
// not from `sdk.getSessionMessages` — the SDK's branch walk silently drops
// replies that CLI bookkeeping records orphaned; see `transcript.ts`.

type ContentBlock = { readonly type?: unknown } & Record<string, unknown>;

type UserPayload = {
  readonly role?: unknown;
  readonly content?: string | ReadonlyArray<ContentBlock>;
};

type AssistantPayload = {
  readonly content?: ReadonlyArray<ContentBlock>;
};

type ClaudeUIMessagePart = ClaudeCodeUIMessage["parts"][number];
type ClaudeToolPart = Extract<ClaudeUIMessagePart, { type: `tool-${string}` }>;
type ClaudeDynamicToolPart = Extract<ClaudeUIMessagePart, { type: "dynamic-tool" }>;

/** Where a not-yet-answered tool_use part sits, so its result can replace it. */
type PendingCall = {
  readonly parts: ClaudeUIMessagePart[];
  readonly index: number;
  readonly toolName: string;
  readonly toolCallId: string;
  readonly input: unknown;
  readonly dynamic: boolean;
  readonly parent: string | null;
};

const META_PREFIXES = ["<command-name>", "<local-command-stdout>", "<command-output>", "Caveat:"];

const isMetaText = (text: string): boolean =>
  META_PREFIXES.some((prefix) => text.startsWith(prefix));

function userTextParts(content: string | ReadonlyArray<ContentBlock>): ClaudeUIMessagePart[] {
  if (typeof content === "string") {
    return isMetaText(content) ? [] : [{ type: "text", text: content }];
  }
  const parts: ClaudeUIMessagePart[] = [];
  for (const block of content) {
    // Text only: images and other block kinds never reach the live stream's
    // user path either, so history stays no richer than live.
    if (block.type === "text" && typeof block.text === "string" && !isMetaText(block.text)) {
      parts.push({ type: "text", text: block.text });
    }
  }
  return parts;
}

// The tool name arrives as a runtime string, so the correlated `tool-<name>` ×
// input union can't be constructed literally; disk data can't prove the
// correlation anyway (inputs are untyped JSON), hence the casts — same
// convention as pi's history fold.
function callPart(call: PendingCall): ClaudeUIMessagePart {
  const attribution = subagentMetadata(call.parent);
  if (call.dynamic) {
    return {
      type: "dynamic-tool",
      toolName: call.toolName,
      toolCallId: call.toolCallId,
      state: "input-available",
      input: call.input,
      providerExecuted: true,
      ...attribution,
    } as ClaudeDynamicToolPart;
  }
  return {
    type: `tool-${call.toolName}`,
    toolCallId: call.toolCallId,
    state: "input-available",
    input: call.input,
    providerExecuted: true,
    ...attribution,
  } as ClaudeToolPart;
}

function resultPart(call: PendingCall, block: ContentBlock, parent: string | null) {
  const attribution = subagentMetadata(parent);
  const settled =
    block.is_error === true
      ? {
          state: "output-error" as const,
          input: call.input,
          errorText: flattenToolResultText(block.content) || "Tool execution failed",
        }
      : // The structured `tool_use_result` is not persisted into
        // `SessionMessage`, so successful outputs stay undefined — the exact
        // shape the live stream produces for subagent tool results.
        { state: "output-available" as const, input: call.input, output: undefined };
  if (call.dynamic) {
    return {
      type: "dynamic-tool",
      toolName: call.toolName,
      toolCallId: call.toolCallId,
      providerExecuted: true,
      ...settled,
      ...attribution,
    } as ClaudeDynamicToolPart;
  }
  return {
    type: `tool-${call.toolName}`,
    toolCallId: call.toolCallId,
    providerExecuted: true,
    ...settled,
    ...attribution,
  } as ClaudeToolPart;
}

/**
 * Fold a claude session's transcript records into UIMessages.
 *
 * Pure and synchronous; records arrive in file (chronological) order from the
 * SDK's `getSessionMessages`.
 */
export function sessionMessagesToUIMessages(
  records: ReadonlyArray<SessionMessage>,
): ClaudeCodeUIMessage[] {
  const messages: ClaudeCodeUIMessage[] = [];
  // The open assistant segment, or null between segments.
  let assistant: ClaudeCodeUIMessage | null = null;
  const pendingCalls = new Map<string, PendingCall>();

  const openAssistant = (uuid: string): ClaudeCodeUIMessage => {
    if (assistant === null) {
      assistant = { id: uuid, role: "assistant", parts: [] };
      messages.push(assistant);
    }
    return assistant;
  };

  const onAssistant = (record: SessionMessage, payload: AssistantPayload) => {
    if (!Array.isArray(payload.content)) return;
    const segment = openAssistant(record.uuid);
    const parent = record.parent_tool_use_id;
    for (const block of payload.content as ReadonlyArray<ContentBlock>) {
      if (block.type === "text" && typeof block.text === "string") {
        segment.parts.push({
          type: "text",
          text: block.text,
          state: "done",
          ...subagentMetadata(parent),
        });
      } else if (
        block.type === "tool_use" &&
        typeof block.id === "string" &&
        typeof block.name === "string"
      ) {
        const call: PendingCall = {
          parts: segment.parts,
          index: segment.parts.length,
          toolName: block.name,
          toolCallId: block.id,
          input: block.input,
          dynamic: !(block.name in claudeCodeTools),
          parent,
        };
        // Orphan calls (run interrupted before the result) stay
        // input-available; a later tool_result replaces the part in place.
        segment.parts.push(callPart(call));
        pendingCalls.set(block.id, call);
      }
      // thinking (and any future block kind) stays off the transcript — the
      // live transform forwards neither.
    }
  };

  const onUser = (record: SessionMessage, payload: UserPayload) => {
    const content = payload.content;
    if (content === undefined) return;
    // Tool results complete their calls wherever they appear — they are
    // plumbing, not conversation, and never open a user message.
    if (typeof content !== "string") {
      for (const block of content) {
        if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
        const call = pendingCalls.get(block.tool_use_id);
        if (call === undefined) continue;
        pendingCalls.delete(block.tool_use_id);
        call.parts[call.index] = resultPart(call, block, record.parent_tool_use_id);
      }
    }
    // Subagent-side user records carry tool plumbing only; real conversation
    // input always belongs to the main loop.
    if (record.parent_tool_use_id !== null) return;
    const parts = userTextParts(content);
    if (parts.length === 0) return;
    assistant = null;
    messages.push({ id: record.uuid, role: "user", parts });
  };

  for (const record of records) {
    // Nested subagents (parent_agent_id set) render inside their Task tool
    // card via their own read, not on the main transcript.
    if (record.parent_agent_id !== null) continue;
    if (record.type === "assistant") {
      onAssistant(record, record.message as AssistantPayload);
    } else if (record.type === "user") {
      onUser(record, record.message as UserPayload);
    }
    // system records are excluded upstream (includeSystemMessages defaults
    // false); anything else stays off the transcript.
  }

  return messages;
}
