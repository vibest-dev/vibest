import type { UIMessageChunk } from "ai";
import { describe, expect, it } from "vitest";

import { sanitizeTail } from "./sanitize-tail";

describe("sanitizeTail", () => {
  it("drops text/reasoning continuations whose opener was evicted", () => {
    const chunks: UIMessageChunk[] = [
      { type: "text-delta", id: "lost", delta: "orphan" },
      { type: "text-end", id: "lost" },
      { type: "reasoning-delta", id: "lost-r", delta: "orphan" },
      { type: "text-start", id: "kept" },
      { type: "text-delta", id: "kept", delta: "tail" },
      { type: "text-end", id: "kept" },
    ];
    expect(sanitizeTail(chunks)).toEqual(chunks.slice(3));
  });

  it("treats tool-input chunks as openers but drops orphaned outputs", () => {
    const orphanOutput: UIMessageChunk = {
      type: "tool-output-available",
      toolCallId: "lost",
      output: { ok: true },
    };
    const opener: UIMessageChunk = {
      type: "tool-input-available",
      toolCallId: "kept",
      toolName: "Bash",
      input: { command: "pwd" },
    };
    const output: UIMessageChunk = {
      type: "tool-output-available",
      toolCallId: "kept",
      output: { ok: true },
    };
    expect(sanitizeTail([orphanOutput, opener, output])).toEqual([opener, output]);
  });

  it("drops orphan tool-input deltas but keeps standalone chunk kinds", () => {
    const orphanDelta: UIMessageChunk = {
      type: "tool-input-delta",
      toolCallId: "lost",
      inputTextDelta: "{",
    };
    const standalone: UIMessageChunk[] = [
      { type: "error", errorText: "boom" },
      { type: "start-step" },
    ];
    expect(sanitizeTail([orphanDelta, ...standalone])).toEqual(standalone);
  });
});
