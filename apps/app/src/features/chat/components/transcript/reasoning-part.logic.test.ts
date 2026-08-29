import { describe, expect, it } from "vitest";

import { shouldRenderReasoningPart } from "./reasoning-part.logic";

describe("shouldRenderReasoningPart", () => {
  it("keeps an empty reasoning block visible while the message is streaming", () => {
    expect(shouldRenderReasoningPart({ type: "reasoning", text: "" }, true)).toBe(true);
  });

  it("drops empty settled reasoning", () => {
    expect(shouldRenderReasoningPart({ type: "reasoning", text: "   ", state: "done" })).toBe(
      false,
    );
  });

  it("renders settled reasoning with text even after the message stops streaming", () => {
    expect(
      shouldRenderReasoningPart({ type: "reasoning", text: "plan", state: "done" }, false),
    ).toBe(true);
  });
});
