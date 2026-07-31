import type { SessionEntry, SessionMessageEntry } from "./protocol";
import { isDynamicPiTool } from "./tools";
import { toolResultText } from "./transform";
import type { PiMetadata, PiUIMessage } from "./ui-message";

// Pi session-file entries → final-form UIMessages, the history counterpart of
// createPiTransform (docs/design/pi-history-read-design.md §4/§5). History is
// settled data, so parts are constructed directly — no chunk replay, no stream
// machinery. `SessionEntry` stops here: callers only ever see `PiUIMessage[]`.
//
// Fold rules:
//   • `get_entries` returns the whole session tree; the current branch is
//     rebuilt by walking `parentId` from `leafId` and reversing.
//   • Segmentation is by user entry: a `user` message entry opens a new
//     message, and the following run of `assistant` / `toolResult` entries
//     folds into ONE assistant message (steer/follow-up injections open new
//     segments — see ADR 0003 for the resulting live/history asymmetry).
//   • messageId: the user entry's id, or the segment's first assistant entry
//     id — pi entry ids are stable across reads, so refreshes reconcile.
//   • Trimming the active turn is the caller's job (the facade folds the
//     runtime snapshot in); this function maps everything it is given.

type PiMessage = SessionMessageEntry["message"];
type PiUserMessage = Extract<PiMessage, { role: "user" }>;
type PiAssistantMessage = Extract<PiMessage, { role: "assistant" }>;
type PiToolResultMessage = Extract<PiMessage, { role: "toolResult" }>;

type PiUIMessagePart = PiUIMessage["parts"][number];
type PiToolPart = Extract<PiUIMessagePart, { type: `tool-${string}` }>;
type PiDynamicToolPart = Extract<PiUIMessagePart, { type: "dynamic-tool" }>;

/** Where a not-yet-answered toolCall part sits, so its result can replace it. */
type PendingCall = {
  readonly parts: PiUIMessagePart[];
  readonly index: number;
  readonly toolName: string;
  readonly toolCallId: string;
  readonly input: unknown;
};

/** The current branch, root → leaf. Null/broken/cyclic chains fold to empty. */
function rebuildBranch(
  entries: ReadonlyArray<SessionEntry>,
  leafId: string | null,
): SessionEntry[] {
  if (leafId === null) return [];
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const chain: SessionEntry[] = [];
  const seen = new Set<string>();
  let cursor: string | null = leafId;
  while (cursor !== null) {
    if (seen.has(cursor)) return [];
    seen.add(cursor);
    const entry = byId.get(cursor);
    if (entry === undefined) return [];
    chain.push(entry);
    cursor = entry.parentId;
  }
  // Leaf→root walk, root→leaf fold (toReversed needs es2023, reverse mutates).
  const branch: SessionEntry[] = [];
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const entry = chain[index];
    if (entry !== undefined) branch.push(entry);
  }
  return branch;
}

function userParts(message: PiUserMessage): PiUIMessagePart[] {
  if (typeof message.content === "string") {
    return [{ type: "text", text: message.content }];
  }
  const parts: PiUIMessagePart[] = [];
  for (const block of message.content) {
    switch (block.type) {
      case "text":
        parts.push({ type: "text", text: block.text });
        break;
      case "image":
        parts.push({
          type: "file",
          mediaType: block.mimeType,
          url: `data:${block.mimeType};base64,${block.data}`,
        });
        break;
      default:
        void (block satisfies never);
    }
  }
  return parts;
}

// The tool name arrives as a runtime string, so the correlated `tool-<name>` ×
// input union can't be constructed literally; disk data can't prove the
// correlation anyway (inputs are untyped JSON), hence the single cast.
function callPart(call: PendingCall): PiUIMessagePart {
  if (isDynamicPiTool(call.toolName)) {
    return {
      type: "dynamic-tool",
      toolName: call.toolName,
      toolCallId: call.toolCallId,
      state: "input-available",
      input: call.input,
      providerExecuted: true,
    } satisfies PiDynamicToolPart;
  }
  return {
    type: `tool-${call.toolName}`,
    toolCallId: call.toolCallId,
    state: "input-available",
    input: call.input,
    providerExecuted: true,
  } as PiToolPart;
}

function resultPart(call: PendingCall, result: PiToolResultMessage): PiUIMessagePart {
  // isError lives in the part state, mirroring the live path where it is a
  // sibling of `tool_execution_end.result` — the output stays result-shaped.
  const output = { content: result.content, details: result.details };
  const settled = result.isError
    ? {
        state: "output-error" as const,
        input: call.input,
        errorText: toolResultText(output) || "Tool execution failed",
      }
    : { state: "output-available" as const, input: call.input, output };
  if (isDynamicPiTool(call.toolName)) {
    return {
      type: "dynamic-tool",
      toolName: call.toolName,
      toolCallId: call.toolCallId,
      providerExecuted: true,
      ...settled,
    } as PiDynamicToolPart;
  }
  return {
    type: `tool-${call.toolName}`,
    toolCallId: call.toolCallId,
    providerExecuted: true,
    ...settled,
  } as PiToolPart;
}

/**
 * Fold a pi session's entries into the current branch's UIMessages.
 *
 * Pure and synchronous; `sessionId` is our server-assigned pi session id,
 * stamped into every message's metadata like the live transform's `start`
 * chunk.
 */
export function entriesToUIMessages(
  entries: ReadonlyArray<SessionEntry>,
  leafId: string | null,
  sessionId: string,
): PiUIMessage[] {
  const messages: PiUIMessage[] = [];
  // The open assistant segment, or null between segments.
  let assistant: PiUIMessage | null = null;
  const pendingCalls = new Map<string, PendingCall>();

  const onUser = (entry: SessionMessageEntry, message: PiUserMessage) => {
    assistant = null;
    messages.push({
      id: entry.id,
      role: "user",
      metadata: { sessionId },
      parts: userParts(message),
    });
  };

  const onAssistant = (entry: SessionMessageEntry, message: PiAssistantMessage) => {
    if (assistant === null) {
      assistant = { id: entry.id, role: "assistant", metadata: { sessionId }, parts: [] };
      messages.push(assistant);
    }
    // Metadata reflects the segment's last assistant entry (final model /
    // stopReason; usage follows pi's own getLastAssistantUsage semantics).
    assistant.metadata = {
      sessionId,
      model: message.model,
      provider: message.provider,
      stopReason: message.stopReason,
      usage: message.usage,
    } satisfies PiMetadata;
    for (const block of message.content) {
      switch (block.type) {
        case "text":
          assistant.parts.push({
            type: "text",
            text: block.text,
            state: "done",
            ...(block.textSignature === undefined
              ? {}
              : { providerMetadata: { pi: { textSignature: block.textSignature } } }),
          });
          break;
        case "thinking":
          // Empty thinking is an encrypted blob (openai-responses); pi stores
          // no plaintext, so there is nothing to render — skip, don't fake.
          if (block.thinking !== "") {
            assistant.parts.push({ type: "reasoning", text: block.thinking, state: "done" });
          }
          break;
        case "toolCall": {
          const call: PendingCall = {
            parts: assistant.parts,
            index: assistant.parts.length,
            toolName: block.name,
            toolCallId: block.id,
            input: block.arguments,
          };
          // Orphan calls (run interrupted before the result) stay
          // input-available; a later toolResult replaces the part in place.
          assistant.parts.push(callPart(call));
          pendingCalls.set(block.id, call);
          break;
        }
        default:
          void (block satisfies never);
      }
    }
  };

  const onToolResult = (message: PiToolResultMessage) => {
    // Paired by id across the whole branch, not just the open segment: a
    // result landing after a steer-injected user entry still completes its
    // call. Results without a matching call (corruption) are dropped.
    const call = pendingCalls.get(message.toolCallId);
    if (call === undefined) return;
    pendingCalls.delete(message.toolCallId);
    call.parts[call.index] = resultPart(call, message);
  };

  for (const entry of rebuildBranch(entries, leafId)) {
    if (entry.type !== "message") {
      // Skipped entry kinds (§5): bookkeeping, extension state, and the
      // summaries/custom_message gap deferred to their own ticket. The
      // satisfies keeps the list exhaustive — a new entry type fails
      // typecheck until routed or listed.
      void (entry.type satisfies
        | "model_change"
        | "thinking_level_change"
        | "custom"
        | "label"
        | "session_info"
        | "compaction"
        | "branch_summary"
        | "custom_message");
      continue;
    }
    const message = entry.message;
    switch (message.role) {
      case "user":
        onUser(entry, message);
        break;
      case "assistant":
        onAssistant(entry, message);
        break;
      case "toolResult":
        onToolResult(message);
        break;
      default:
        // Custom message roles stay off the transcript this phase (§5).
        void (message.role satisfies
          | "bashExecution"
          | "custom"
          | "branchSummary"
          | "compactionSummary");
    }
  }

  return messages;
}
