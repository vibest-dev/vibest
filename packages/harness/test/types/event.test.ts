import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineEvent, TokenUsageSchema, TurnErrorSchema } from "../../src/types/event";

describe("defineEvent", () => {
  it("carries the literal type and a validating object schema", () => {
    const Ended = defineEvent({
      type: "session.turn.ended",
      schema: { turnId: z.string(), outcome: z.enum(["completed", "failed", "canceled"]) },
    });
    expect(Ended.type).toBe("session.turn.ended");
    expect(Ended.schema.parse({ turnId: "t1", outcome: "completed" })).toEqual({
      turnId: "t1",
      outcome: "completed",
    });
    expect(() => Ended.schema.parse({ turnId: 1, outcome: "completed" })).toThrow(z.ZodError);
  });
});

describe("shared schemas", () => {
  it("parses token usage with optional cache fields", () => {
    expect(TokenUsageSchema.parse({ inputTokens: 10, outputTokens: 5 })).toEqual({
      inputTokens: 10,
      outputTokens: 5,
    });
  });

  it("rejects an unknown turn-error category", () => {
    expect(() => TurnErrorSchema.parse({ message: "x", category: "nope" })).toThrow(z.ZodError);
  });
});
