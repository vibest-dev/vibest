import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";

import { foldToUIMessages } from "../../src/claude-code/fold";

describe("foldToUIMessages", () => {
  it("folds a single assistant turn into one UIMessage with a text part", async () => {
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
  });
});
