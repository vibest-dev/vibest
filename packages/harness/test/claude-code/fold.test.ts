import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";

import { foldToUIMessages } from "../../src/claude-code/fold";

describe("foldToUIMessages", () => {
  it("folds a single assistant turn into one UIMessage with a text part plus system/result data parts", async () => {
    const transcript = [
      { type: "system", subtype: "init" },
      {
        type: "assistant",
        parent_tool_use_id: null,
        message: { id: "m1", content: [{ type: "text", text: "hello" }] },
      },
      { type: "result", subtype: "success" },
    ] as unknown as SDKMessage[];

    const messages = await foldToUIMessages(transcript);

    expect(messages).toHaveLength(1);
    const firstMsg = messages[0]!;
    const hasTextPart = firstMsg.parts.some(
      (p) => (p as any).type === "text" && (p as any).text === "hello",
    );
    expect(hasTextPart).toBe(true);
    const hasSystemInitPart = firstMsg.parts.some((p) => (p as any).type === "data-system/init");
    expect(hasSystemInitPart).toBe(true);
    const hasResultSuccessPart = firstMsg.parts.some(
      (p) => (p as any).type === "data-result/success",
    );
    expect(hasResultSuccessPart).toBe(true);
  });

  it("folds a registry tool call into a static tool part carrying the structured tool_use_result as output", async () => {
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

    const messages = await foldToUIMessages(transcript);

    const toolPart = messages[0]!.parts.find((p) => (p as any).type === "tool-Read") as any;
    expect(toolPart).toBeDefined();
    expect(toolPart.output).toEqual({ type: "text", file: { filePath: "/a", content: "hi" } });
  });

  it("folds an unknown tool call into a dynamic-tool part with undefined output when tool_use_result is absent", async () => {
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

    const messages = await foldToUIMessages(transcript);

    const toolPart = messages[0]!.parts.find((p) => (p as any).type === "dynamic-tool") as any;
    expect(toolPart).toBeDefined();
    expect(toolPart.toolName).toBe("mcp__foo__bar");
    expect(toolPart.output).toBeUndefined();
  });
});
