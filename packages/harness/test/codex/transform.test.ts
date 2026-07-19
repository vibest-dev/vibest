import { describe, expect, it } from "vitest";

import type { ServerNotification } from "../../src/codex/protocol";
import { createCodexTransform } from "../../src/codex/transform";

const n = (method: string, params: unknown) => ({ method, params }) as ServerNotification;
const types = (chunks: unknown[]) => chunks.map((c) => (c as { type: string }).type);

describe("createCodexTransform", () => {
  it("turn/started → start with thread metadata", () => {
    const t = createCodexTransform();
    const chunks = [...t(n("turn/started", { threadId: "th", turn: { id: "turn1" } }))];
    expect(chunks[0]).toMatchObject({
      type: "start",
      messageId: "turn1",
      messageMetadata: { sessionId: "th" },
    });
  });

  it("agentMessage deltas stream text; completion without deltas emits whole text", () => {
    const t = createCodexTransform();
    const viaDelta = [
      ...t(n("item/agentMessage/delta", { threadId: "th", itemId: "i1", delta: "he" })),
    ];
    expect(types(viaDelta)).toEqual(["text-start", "text-delta"]);
    const t2 = createCodexTransform();
    const whole = [
      ...t2(
        n("item/completed", {
          threadId: "th",
          item: { type: "agentMessage", id: "i2", text: "hi" },
        }),
      ),
    ];
    expect(types(whole)).toEqual(["text-start", "text-delta", "text-end"]);
  });

  it("tool items forward the whole item as input then output", () => {
    const t = createCodexTransform();
    const item = { type: "commandExecution", id: "c1", command: "ls", cwd: "/" };
    const started = [...t(n("item/started", { threadId: "th", item }))];
    expect(started[0]).toMatchObject({
      type: "tool-input-available",
      toolCallId: "c1",
      toolName: "commandExecution",
      input: item,
      dynamic: false,
    });
    const done = [...t(n("item/completed", { threadId: "th", item }))];
    expect(done[0]).toMatchObject({ type: "tool-output-available", output: item });
  });

  it("mcpToolCall is dynamic", () => {
    const t = createCodexTransform();
    const item = { type: "mcpToolCall", id: "m1" };
    const chunks = [...t(n("item/started", { threadId: "th", item }))];
    expect(chunks[0]).toMatchObject({ dynamic: true });
  });

  it("sleep and subAgentActivity are skipped", () => {
    const t = createCodexTransform();
    const sleep = { type: "sleep", id: "s1", durationMs: 1000 };
    expect([...t(n("item/completed", { threadId: "th", item: sleep }))]).toEqual([]);
    const activity = {
      type: "subAgentActivity",
      id: "a1",
      kind: "spawned",
      agentThreadId: "th2",
      agentPath: "p",
    };
    expect([...t(n("item/completed", { threadId: "th", item: activity }))]).toEqual([]);
  });

  it("turn/completed → finish; terminal error → error + finish", () => {
    const t = createCodexTransform();
    expect(
      types([
        ...t(n("turn/completed", { threadId: "th", turn: { id: "t1", status: "completed" } })),
      ]),
    ).toEqual(["finish"]);
    expect(
      types([
        ...t(
          n("error", { threadId: "th", turnId: "t1", willRetry: false, error: { message: "x" } }),
        ),
      ]),
    ).toEqual(["error", "finish"]);
    expect(
      types([
        ...t(
          n("error", { threadId: "th", turnId: "t1", willRetry: true, error: { message: "x" } }),
        ),
      ]),
    ).toEqual(["error"]);
  });
});
