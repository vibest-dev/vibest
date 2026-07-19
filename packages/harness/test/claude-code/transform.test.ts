import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";

import { createTransform } from "../../src/claude-code/transform";

const types = (chunks: unknown[]) => chunks.map((c) => (c as { type: string }).type);

const toolUse = (name: string, id = "t1"): SDKMessage =>
  ({
    type: "assistant",
    parent_tool_use_id: null,
    message: { id: "m1", content: [{ type: "tool_use", id, name, input: { command: "ls" } }] },
  }) as unknown as SDKMessage;

const toolResult = (over: Record<string, unknown> = {}, id = "t1"): SDKMessage =>
  ({
    type: "user",
    parent_tool_use_id: null,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "1→hi" }] },
    tool_use_result: { type: "text", file: { filePath: "/a", content: "hi" } },
    ...over,
  }) as unknown as SDKMessage;

describe("createTransform", () => {
  it("emits start for system.init", () => {
    const transform = createTransform();
    const chunks = [...transform({ type: "system", subtype: "init" } as SDKMessage)];
    expect(types(chunks)).toEqual(["start"]);
  });

  it("tool output is the structured tool_use_result, not the model-facing content", () => {
    const transform = createTransform();
    Array.from(transform(toolUse("Read")));
    const chunks = [...transform(toolResult())];
    expect(chunks[0]).toMatchObject({
      type: "tool-output-available",
      toolCallId: "t1",
      output: { type: "text", file: { filePath: "/a", content: "hi" } },
    });
  });

  it("missing tool_use_result yields undefined output (no content fallback)", () => {
    const transform = createTransform();
    Array.from(transform(toolUse("Bash")));
    const chunks = [...transform(toolResult({ tool_use_result: undefined }))];
    expect(chunks[0]).toMatchObject({ type: "tool-output-available", output: undefined });
  });

  it("registry tools are dynamic:false, unknown tools dynamic:true — on input AND output", () => {
    const transform = createTransform();
    const known = [...transform(toolUse("Bash", "k1"))];
    const unknown = [...transform(toolUse("mcp__foo__bar", "u1"))];
    expect(known[0]).toMatchObject({ dynamic: false });
    expect(unknown[0]).toMatchObject({ dynamic: true });
    const knownOut = [...transform(toolResult({}, "k1"))];
    const unknownOut = [...transform(toolResult({}, "u1"))];
    expect(knownOut[0]).toMatchObject({ dynamic: false });
    expect(unknownOut[0]).toMatchObject({ dynamic: true });
  });

  it("error results flatten content into errorText", () => {
    const transform = createTransform();
    Array.from(transform(toolUse("Bash")));
    const msg = {
      type: "user",
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            is_error: true,
            content: [{ type: "text", text: "boom" }],
          },
        ],
      },
    } as unknown as SDKMessage;
    const chunks = [...transform(msg)];
    expect(chunks[0]).toMatchObject({ type: "tool-output-error", errorText: "boom" });
  });

  it("result.success emits finish", () => {
    const transform = createTransform();
    const chunks = [...transform({ type: "result", subtype: "success" } as SDKMessage)];
    expect(types(chunks)).toEqual(["finish"]);
  });

  it("result errors emit error + finish", () => {
    const transform = createTransform();
    const chunks = [
      ...transform({
        type: "result",
        subtype: "error_max_turns",
        errors: ["too many turns"],
      } as unknown as SDKMessage),
    ];
    expect(types(chunks)).toEqual(["error", "finish"]);
    expect(chunks[0]).toMatchObject({ errorText: "too many turns" });
  });
});
