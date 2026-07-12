import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { transform } from "../../src/claude-code/transform";

const collect = (m: SDKMessage) => [...transform(m)].map((c) => c.type);

describe("transform", () => {
  it("maps system.init to a start chunk", () => {
    expect(collect({ type: "system", subtype: "init" } as SDKMessage)).toEqual(["start"]);
  });

  it("maps an assistant text part to text start/delta/end", () => {
    const msg = {
      type: "assistant",
      parent_tool_use_id: null,
      message: { id: "m1", content: [{ type: "text", text: "hi" }] },
    } as unknown as SDKMessage;
    expect(collect(msg)).toEqual(["text-start", "text-delta", "text-end"]);
  });

  it("maps an assistant tool_use to tool-input-available", () => {
    const msg = {
      type: "assistant",
      parent_tool_use_id: null,
      message: {
        id: "m1",
        content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }],
      },
    } as unknown as SDKMessage;
    const chunks = [...transform(msg)];
    expect(chunks[0]).toMatchObject({
      type: "tool-input-available",
      toolCallId: "t1",
      toolName: "Bash",
    });
  });

  it("maps result.success to a finish chunk", () => {
    expect(collect({ type: "result", subtype: "success" } as SDKMessage)).toEqual(["finish"]);
  });
});
