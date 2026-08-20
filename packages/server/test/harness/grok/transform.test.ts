import { expect, it } from "vitest";

import type { RpcNotification } from "../../../src/harness/grok/protocol";
import { createGrokTransform } from "../../../src/harness/grok/transform";

const update = (sessionUpdate: string, extra: Record<string, unknown> = {}): RpcNotification => ({
  method: "session/update",
  params: { sessionId: "s1", update: { sessionUpdate, ...extra } },
});

it("streams text and reasoning deltas, then finishes on turn_completed", () => {
  const transform = createGrokTransform();
  const chunks = [
    ...transform(update("agent_thought_chunk", { content: { type: "text", text: "hmm" } })),
    ...transform(update("agent_message_chunk", { content: { type: "text", text: "hi" } })),
    ...transform({
      method: "_x.ai/session_notification",
      params: {
        sessionId: "s1",
        update: { sessionUpdate: "turn_completed", stop_reason: "end_turn" },
      },
    }),
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

it("emits typed tool input from tool_call", () => {
  const transform = createGrokTransform();
  const chunks = [
    ...transform(
      update("tool_call", {
        toolCallId: "c1",
        title: "read_file",
        rawInput: { target_file: "/tmp/a.ts" },
        _meta: { "x.ai/tool": { name: "read_file" } },
      }),
    ),
    ...transform(
      update("tool_call_update", {
        toolCallId: "c1",
        status: "completed",
        rawOutput: { lines: 3 },
      }),
    ),
  ];
  expect(chunks).toEqual([
    { type: "start" },
    {
      type: "tool-input-available",
      toolCallId: "c1",
      toolName: "read_file",
      input: { target_file: "/tmp/a.ts" },
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

it("skips user echoes and command list updates", () => {
  const transform = createGrokTransform();
  const chunks = [
    ...transform(update("user_message_chunk", { content: { type: "text", text: "hello" } })),
    ...transform(update("available_commands_update", { availableCommands: [] })),
  ];
  expect(chunks).toEqual([]);
});
