import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";

// File-order parse of a Claude CLI session transcript (`<sessionId>.jsonl`),
// replacing `sdk.getSessionMessages` as the history source.
//
// Why not the SDK read: it reconstructs the "current branch" by picking the
// best leaf and walking `parentUuid` upward. CLI bookkeeping records (an
// `api_error` after a turn, for instance) sometimes re-parent the chain past
// an assistant reply, orphaning it on a dead branch — the SDK then silently
// drops a reply that other clients streamed live, and transcripts diverge
// across clients. Multi-client sync needs the transcript as written, so this
// parses the file in order and skips branch reconstruction entirely.
//
// Trade-off, on purpose: a session that was genuinely forked (rewound) outside
// vibest shows both branches' records. vibest never forks the sessions it
// drives, and a complete transcript beats a silently incomplete one.
//
// The filter matches the SDK's own record predicate (user/assistant with a
// uuid, not meta, not sidechain, not team-scoped), and the output shape is the
// SDK's `SessionMessage`, so the fold downstream is unchanged.
export function parseTranscriptRecords(content: string, sessionId: string): SessionMessage[] {
  const records: SessionMessage[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (raw.type !== "user" && raw.type !== "assistant") continue;
    if (typeof raw.uuid !== "string") continue;
    if (raw.isMeta === true || raw.isSidechain === true) continue;
    if (typeof raw.teamName === "string" && raw.teamName !== "") continue;
    records.push({
      type: raw.type,
      uuid: raw.uuid,
      session_id: typeof raw.sessionId === "string" ? raw.sessionId : sessionId,
      message: raw.message,
      parent_tool_use_id: null,
      parent_agent_id: null,
    } as SessionMessage);
  }
  return records;
}
