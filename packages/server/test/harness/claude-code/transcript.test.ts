import { describe, expect, it } from "vitest";

import { sessionMessagesToUIMessages } from "../../../src/harness/claude-code/history";
import { parseTranscriptRecords } from "../../../src/harness/claude-code/transcript";

const line = (record: Record<string, unknown>) => JSON.stringify(record);

const userLine = (uuid: string, parentUuid: string | null, text: string, over = {}) =>
  line({
    type: "user",
    uuid,
    parentUuid,
    sessionId: "s1",
    isSidechain: false,
    message: { role: "user", content: [{ type: "text", text }] },
    ...over,
  });

const assistantLine = (uuid: string, parentUuid: string, text: string) =>
  line({
    type: "assistant",
    uuid,
    parentUuid,
    sessionId: "s1",
    isSidechain: false,
    message: { role: "assistant", content: [{ type: "text", text }] },
  });

describe("parseTranscriptRecords", () => {
  it("keeps replies the SDK's branch walk would orphan behind bookkeeping records", () => {
    // The shape observed in real files: after turn 1's reply, an api_error
    // system record re-parents the chain onto the pre-reply attachment, so a
    // leaf walk (u2 → system → attachment → u1) never visits a1. File order
    // must keep it — other clients streamed that reply live.
    const content = [
      userLine("u1", null, "what color is the sky?"),
      line({ type: "attachment", uuid: "att1", parentUuid: "u1", sessionId: "s1" }),
      assistantLine("a1", "att1", "blue"),
      line({
        type: "system",
        subtype: "api_error",
        uuid: "sys1",
        parentUuid: "att1",
        sessionId: "s1",
      }),
      userLine("u2", "sys1", "and grass?"),
      assistantLine("a2", "u2", "green"),
    ].join("\n");

    const records = parseTranscriptRecords(content, "s1");
    expect(records.map((record) => record.uuid)).toEqual(["u1", "a1", "u2", "a2"]);

    const messages = sessionMessagesToUIMessages(records);
    expect(messages.map((message) => ({ role: message.role, id: message.id }))).toEqual([
      { role: "user", id: "u1" },
      { role: "assistant", id: "a1" },
      { role: "user", id: "u2" },
      { role: "assistant", id: "a2" },
    ]);
  });

  it("filters meta, sidechain, and team-scoped records like the SDK does", () => {
    const content = [
      userLine("caveat", null, "Caveat: generated", { isMeta: true }),
      userLine("side", null, "sidechain prompt", { isSidechain: true }),
      userLine("team", null, "team message", { teamName: "squad" }),
      line({ type: "queue-operation", sessionId: "s1" }),
      line({ type: "progress", uuid: "p1", sessionId: "s1" }),
      "not json at all",
      "",
      userLine("u1", null, "real question"),
    ].join("\n");

    expect(parseTranscriptRecords(content, "s1").map((record) => record.uuid)).toEqual(["u1"]);
  });

  it("fills session_id from the record or the caller's fallback", () => {
    const withOwn = parseTranscriptRecords(userLine("u1", null, "hi"), "fallback");
    expect(withOwn[0]?.session_id).toBe("s1");
    const bare = line({
      type: "user",
      uuid: "u2",
      message: { role: "user", content: "hi" },
    });
    expect(parseTranscriptRecords(bare, "fallback")[0]?.session_id).toBe("fallback");
  });
});
