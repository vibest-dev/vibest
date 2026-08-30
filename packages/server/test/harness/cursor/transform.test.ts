import { expect, it } from "vitest";

import type { RpcNotification } from "../../../src/harness/cursor/protocol";
import { TURN_END_METHOD } from "../../../src/harness/cursor/protocol";
import { createCursorTransform } from "../../../src/harness/cursor/transform";

const update = (sessionUpdate: string, extra: Record<string, unknown> = {}): RpcNotification => ({
  method: "session/update",
  params: { sessionId: "s1", update: { sessionUpdate, ...extra } },
});

it("streams text and reasoning deltas, then finishes on endTurn", () => {
  const transform = createCursorTransform("s1");
  const chunks = [
    ...transform.apply(update("agent_thought_chunk", { content: { type: "text", text: "hmm" } })),
    ...transform.apply(update("agent_message_chunk", { content: { type: "text", text: "hi" } })),
    ...transform.endTurn(),
  ];
  expect(chunks.map((chunk) => chunk.type)).toEqual([
    "start",
    "reasoning-start",
    "reasoning-delta",
    "reasoning-end",
    "text-start",
    "text-delta",
    "text-end",
    "finish",
  ]);
});

it("finishes when session/prompt return is injected as vibest/turn_end", () => {
  const transform = createCursorTransform("s1");
  const chunks = [
    ...transform.apply(update("agent_message_chunk", { content: { type: "text", text: "hi" } })),
    ...transform.apply({ method: TURN_END_METHOD, params: { sessionId: "s1" } }),
  ];
  expect(chunks.map((chunk) => chunk.type)).toEqual([
    "start",
    "text-start",
    "text-delta",
    "text-end",
    "finish",
  ]);
});

it("emits typed tool input from tool_call", () => {
  const transform = createCursorTransform("s1");
  const chunks = [
    ...transform.apply(
      update("tool_call", {
        toolCallId: "c1",
        title: "Read",
        rawInput: { path: "/tmp/a.ts" },
      }),
    ),
    ...transform.apply(
      update("tool_call_update", {
        toolCallId: "c1",
        status: "completed",
        rawOutput: { lines: 3 },
      }),
    ),
  ];
  expect(chunks[0]).toMatchObject({ type: "start", messageMetadata: { sessionId: "s1" } });
  expect(chunks.slice(1)).toEqual([
    {
      type: "tool-input-available",
      toolCallId: "c1",
      toolName: "Read",
      input: { path: "/tmp/a.ts" },
      providerExecuted: true,
      dynamic: false,
    },
    {
      type: "tool-output-available",
      toolCallId: "c1",
      output: { lines: 3 },
      providerExecuted: true,
      dynamic: false,
    },
  ]);
});

it("keeps unknown tools dynamic", () => {
  const transform = createCursorTransform("s1");
  const chunks = [
    ...transform.apply(
      update("tool_call", {
        toolCallId: "c1",
        title: "mystery_tool",
        rawInput: {},
      }),
    ),
    ...transform.apply(
      update("tool_call_update", {
        toolCallId: "c1",
        status: "completed",
        rawOutput: { ok: true },
      }),
    ),
  ];
  expect(chunks[1]).toMatchObject({ type: "tool-input-available", dynamic: true });
  expect(chunks[2]).toMatchObject({ type: "tool-output-available", dynamic: true });
});

it("skips user echoes and command list updates", () => {
  const transform = createCursorTransform("s1");
  const chunks = [
    ...transform.apply(update("user_message_chunk", { content: { type: "text", text: "hello" } })),
    ...transform.apply(update("available_commands_update", { availableCommands: [] })),
  ];
  expect(chunks).toEqual([]);
});
