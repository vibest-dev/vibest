import { describe, expect, it } from "vitest";

import type { AgentSessionEvent } from "../../../src/harness/pi/protocol";
import { createPiTransform } from "../../../src/harness/pi/transform";

const e = (event: unknown) => event as AgentSessionEvent;
const types = (chunks: unknown[]) => chunks.map((c) => (c as { type: string }).type);

const assistant = (over: Record<string, unknown> = {}) => ({
  role: "assistant",
  content: [],
  api: "anthropic-messages",
  provider: "anthropic",
  model: "m1",
  usage: { input: 1, output: 2 },
  stopReason: "stop",
  timestamp: 0,
  ...over,
});

const update = (assistantMessageEvent: Record<string, unknown>) =>
  e({ type: "message_update", message: assistant(), assistantMessageEvent });

// RPC mode never emits the assistantMessageEvent `start` delta; the
// per-assistant-message marker on the real wire is `message_start`.
const assistantStart = () => e({ type: "message_start", message: assistant() });
const userStart = (text = "hi") =>
  e({ type: "message_start", message: { role: "user", content: text, timestamp: 0 } });

describe("createPiTransform", () => {
  it("opens the turn once per run, even across retries", () => {
    const t = createPiTransform("s1");
    const first = [...t(e({ type: "agent_start" }))];
    expect(first[0]).toMatchObject({ type: "start", messageMetadata: { sessionId: "s1" } });
    expect([...t(e({ type: "agent_start" }))]).toEqual([]);
    expect(types([...t(e({ type: "agent_settled" }))])).toEqual(["finish"]);
    // A settle without an open turn stays silent.
    expect([...t(e({ type: "agent_settled" }))]).toEqual([]);
  });

  it("streams text and thinking deltas with message-scoped block ids", () => {
    const t = createPiTransform("s1");
    const run = (event: AgentSessionEvent) => [...t(event)];
    run(e({ type: "agent_start" }));
    run(assistantStart());
    const chunks = [
      ...t(update({ type: "thinking_start", contentIndex: 0 })),
      ...t(update({ type: "thinking_delta", contentIndex: 0, delta: "hm" })),
      ...t(update({ type: "thinking_end", contentIndex: 0, content: "hm" })),
      ...t(update({ type: "text_start", contentIndex: 1 })),
      ...t(update({ type: "text_delta", contentIndex: 1, delta: "hi" })),
      ...t(update({ type: "text_end", contentIndex: 1, content: "hi" })),
    ];
    expect(types(chunks)).toEqual([
      "reasoning-start",
      "reasoning-delta",
      "reasoning-end",
      "text-start",
      "text-delta",
      "text-end",
    ]);
    expect(chunks[3]).toMatchObject({ id: "m1.1" });

    // The second assistant message reuses contentIndex 0 under a fresh ordinal.
    run(assistantStart());
    const second = run(update({ type: "text_start", contentIndex: 0 }));
    expect(second[0]).toMatchObject({ id: "m2.0" });
  });

  it("splits the UIMessage when a steered user message lands mid-run", () => {
    const t = createPiTransform("s1");
    const run = (event: AgentSessionEvent) => [...t(event)];
    const opened = run(e({ type: "agent_start" }));
    const firstMessageId = (opened[0] as { messageId: string }).messageId;
    // The prompting input's echo arrives before any assistant output: no split.
    expect(run(userStart("original prompt"))).toEqual([]);
    run(assistantStart());
    run(update({ type: "text_start", contentIndex: 0 }));
    run(update({ type: "text_delta", contentIndex: 0, delta: "before" }));
    run(update({ type: "text_end", contentIndex: 0, content: "before" }));

    // Steer delivery: deferred until the next assistant message opens, so an
    // interrupt right after delivery leaves no empty trailing message.
    expect(run(userStart("steer"))).toEqual([]);
    const split = run(assistantStart());
    expect(types(split)).toEqual(["finish", "start"]);
    expect((split[1] as { messageId: string }).messageId).not.toBe(firstMessageId);

    // Blocks of the continuation land under a fresh ordinal, in the new message.
    const cont = run(update({ type: "text_start", contentIndex: 0 }));
    expect(cont[0]).toMatchObject({ id: "m2.0" });
    expect(types(run(e({ type: "agent_settled" })))).toEqual(["finish"]);
  });

  it("settles cleanly when a steer lands but no assistant message follows", () => {
    const t = createPiTransform("s1");
    const run = (event: AgentSessionEvent) => [...t(event)];
    run(e({ type: "agent_start" }));
    run(assistantStart());
    run(userStart("steer"));
    // Interrupted before the next LLM call: exactly one terminal finish.
    expect(types(run(e({ type: "agent_settled" })))).toEqual(["finish"]);
  });

  it("recovers whole text when a block ends without streaming deltas", () => {
    const t = createPiTransform("s1");
    const run = (event: AgentSessionEvent) => [...t(event)];
    run(e({ type: "agent_start" }));
    run(assistantStart());
    run(update({ type: "text_start", contentIndex: 0 }));
    const end = [...t(update({ type: "text_end", contentIndex: 0, content: "whole" }))];
    expect(types(end)).toEqual(["text-delta", "text-end"]);
    expect(end[0]).toMatchObject({ delta: "whole" });
  });

  it("forwards tool executions as typed tool chunks", () => {
    const t = createPiTransform("s1");
    const started = [
      ...t(
        e({
          type: "tool_execution_start",
          toolCallId: "c1",
          toolName: "bash",
          args: { command: "ls" },
        }),
      ),
    ];
    expect(started[0]).toMatchObject({
      type: "tool-input-available",
      toolCallId: "c1",
      toolName: "bash",
      input: { command: "ls" },
      dynamic: false,
    });

    const result = { content: [{ type: "text", text: "ok" }], details: {} };
    const done = [
      ...t(
        e({
          type: "tool_execution_end",
          toolCallId: "c1",
          toolName: "bash",
          result,
          isError: false,
        }),
      ),
    ];
    expect(done[0]).toMatchObject({ type: "tool-output-available", output: result });
  });

  it("maps tool failures to tool-output-error and extension tools to dynamic", () => {
    const t = createPiTransform("s1");
    const started = [
      ...t(
        e({ type: "tool_execution_start", toolCallId: "c2", toolName: "my_ext_tool", args: {} }),
      ),
    ];
    expect(started[0]).toMatchObject({ dynamic: true });
    const failed = [
      ...t(
        e({
          type: "tool_execution_end",
          toolCallId: "c2",
          toolName: "my_ext_tool",
          result: { content: [{ type: "text", text: "nope" }] },
          isError: true,
        }),
      ),
    ];
    expect(failed[0]).toMatchObject({ type: "tool-output-error", errorText: "nope" });
  });

  it("skips assistant summaries and surfaces run errors", () => {
    const t = createPiTransform("s1");
    const run = (event: AgentSessionEvent) => [...t(event)];
    run(e({ type: "agent_start" }));
    expect([...t(e({ type: "message_end", message: assistant() }))]).toEqual([]);

    const failed = assistant({ stopReason: "error", errorMessage: "boom" });
    const ended = [...t(e({ type: "agent_end", messages: [failed], willRetry: false }))];
    expect(ended[0]).toMatchObject({ type: "error", errorText: "boom" });
    // The terminal finish still comes from agent_settled.
    expect(types([...t(e({ type: "agent_settled" }))])).toEqual(["finish"]);
  });

  it("skips compaction and retry lifecycles", () => {
    const t = createPiTransform("s1");
    expect([...t(e({ type: "compaction_start", reason: "threshold" }))]).toEqual([]);
    expect([
      ...t(e({ type: "compaction_end", reason: "threshold", result: undefined, aborted: false })),
    ]).toEqual([]);
    expect([
      ...t(
        e({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 10, errorMessage: "x" }),
      ),
    ]).toEqual([]);
    expect([...t(e({ type: "auto_retry_end", success: true, attempt: 1 }))]).toEqual([]);
  });

  it("ignores bookkeeping events and user-message echoes", () => {
    const t = createPiTransform("s1");
    for (const event of [
      { type: "turn_start" },
      { type: "turn_end", message: assistant(), toolResults: [] },
      { type: "message_start", message: { role: "user", content: "hi", timestamp: 0 } },
      { type: "message_end", message: { role: "user", content: "hi", timestamp: 0 } },
      { type: "queue_update", steering: [], followUp: [] },
      { type: "session_info_changed", name: "n" },
      { type: "thinking_level_changed", level: "high" },
      {
        type: "tool_execution_update",
        toolCallId: "c1",
        toolName: "bash",
        args: {},
        partialResult: {},
      },
    ]) {
      expect([...t(e(event))]).toEqual([]);
    }
  });
});
