import assert from "node:assert/strict";

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe } from "vitest";

import { foldToUIMessages } from "../../src/claude-code/fold";

describe("foldToUIMessages", () => {
  it.effect("folds a single assistant turn into one UIMessage", () =>
    Effect.gen(function* () {
      const transcript = [
        { type: "system", subtype: "init" },
        {
          type: "assistant",
          parent_tool_use_id: null,
          message: { id: "m1", content: [{ type: "text", text: "hello" }] },
        },
        { type: "result", subtype: "success" },
      ] as unknown as SDKMessage[];

      const messages = yield* foldToUIMessages(transcript);
      assert.equal(messages.length, 1);
      const parts = messages[0]!.parts as ReadonlyArray<{ type: string; text?: string }>;
      assert.ok(parts.some((part) => part.type === "text" && part.text === "hello"));
      assert.ok(!parts.some((part) => part.type.startsWith("data-")));
    }),
  );

  it.effect("folds a registry tool call with structured output", () =>
    Effect.gen(function* () {
      const transcript = [
        { type: "system", subtype: "init" },
        {
          type: "assistant",
          parent_tool_use_id: null,
          message: {
            id: "m1",
            content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a" } }],
          },
        },
        {
          type: "user",
          parent_tool_use_id: null,
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "t1", content: "1→hi" }],
          },
          tool_use_result: { type: "text", file: { filePath: "/a", content: "hi" } },
        },
        { type: "result", subtype: "success" },
      ] as unknown as SDKMessage[];

      const messages = yield* foldToUIMessages(transcript);
      const part = messages[0]!.parts.find(
        (candidate) => (candidate as { type: string }).type === "tool-Read",
      ) as { output?: unknown } | undefined;
      assert.ok(part);
      assert.deepEqual(part.output, {
        type: "text",
        file: { filePath: "/a", content: "hi" },
      });
    }),
  );

  it.effect("folds an unknown tool call into a dynamic tool part", () =>
    Effect.gen(function* () {
      const transcript = [
        { type: "system", subtype: "init" },
        {
          type: "assistant",
          parent_tool_use_id: null,
          message: {
            id: "m1",
            content: [{ type: "tool_use", id: "t2", name: "mcp__foo__bar", input: {} }],
          },
        },
        {
          type: "user",
          parent_tool_use_id: null,
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "t2", content: "ok" }],
          },
        },
        { type: "result", subtype: "success" },
      ] as unknown as SDKMessage[];

      const messages = yield* foldToUIMessages(transcript);
      const part = messages[0]!.parts.find(
        (candidate) => (candidate as { type: string }).type === "dynamic-tool",
      ) as { toolName?: string; output?: unknown } | undefined;
      assert.ok(part);
      assert.equal(part.toolName, "mcp__foo__bar");
      assert.equal(part.output, undefined);
    }),
  );
});
