import type { UIMessageChunk } from "ai";

// Stream chunks are paired sequences — text-start → text-delta* → text-end,
// tool-input-start → tool-input-delta* → tool-output-available — and the
// message fold is a state machine that looks each continuation up by the id
// its opener created (and throws when it is missing). A truncated buffer lost
// its head, so the retained tail can open with continuations whose openers
// were evicted; this filter drops those orphans so the fold starts from the
// first chunk that stands on its own.
//
// Opener status follows the fold's actual behaviour (ai `processUIMessageStream`):
// `tool-input-start` / `tool-input-available` / `tool-input-error` upsert the
// tool part (so they open), while `tool-output-*` and approvals only look one
// up (so they orphan without their opener). Chunk kinds with no pairing
// (start/finish, steps, data-*, file, source-*, error, message metadata) pass
// through untouched.
export function sanitizeTail(chunks: ReadonlyArray<UIMessageChunk>): UIMessageChunk[] {
  const openPartIds = new Set<string>();
  const openToolIds = new Set<string>();
  const openApprovalIds = new Set<string>();
  const kept: UIMessageChunk[] = [];
  for (const chunk of chunks) {
    switch (chunk.type) {
      case "text-start":
      case "reasoning-start":
        openPartIds.add(chunk.id);
        break;
      case "text-delta":
      case "text-end":
      case "reasoning-delta":
      case "reasoning-end":
        if (!openPartIds.has(chunk.id)) continue;
        break;
      case "tool-input-start":
      case "tool-input-available":
      case "tool-input-error":
        openToolIds.add(chunk.toolCallId);
        break;
      case "tool-input-delta":
      case "tool-output-available":
      case "tool-output-error":
      case "tool-output-denied":
        if (!openToolIds.has(chunk.toolCallId)) continue;
        break;
      case "tool-approval-request":
        if (!openToolIds.has(chunk.toolCallId)) continue;
        openApprovalIds.add(chunk.approvalId);
        break;
      case "tool-approval-response":
        if (!openApprovalIds.has(chunk.approvalId)) continue;
        break;
      default:
        break;
    }
    kept.push(chunk);
  }
  return kept;
}
