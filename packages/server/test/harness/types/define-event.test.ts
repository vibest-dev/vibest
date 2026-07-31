import { TokenUsageSchema, TurnErrorSchema } from "@vibest/contract";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { defineEvent } from "../../../src/harness/events/framework";

const decodeTokenUsage = Schema.decodeUnknownSync(TokenUsageSchema);
const decodeTurnError = Schema.decodeUnknownSync(TurnErrorSchema);

describe("defineEvent", () => {
  const Ended = defineEvent({
    type: "session.turn.ended",
    schema: {
      turnId: Schema.String,
      outcome: Schema.Literals(["completed", "failed", "canceled"]),
    },
  });
  const decodeEnded = Schema.decodeUnknownSync(Ended.schema);

  it("carries the literal type and a validating object schema", () => {
    expect(Ended.type).toBe("session.turn.ended");
    expect(decodeEnded({ turnId: "t1", outcome: "completed" })).toEqual({
      turnId: "t1",
      outcome: "completed",
    });
    expect(() => decodeEnded({ turnId: 1, outcome: "completed" })).toThrow(/Expected/);
  });
});

describe("shared schemas", () => {
  it("parses token usage with optional cache fields", () => {
    expect(decodeTokenUsage({ inputTokens: 10, outputTokens: 5 })).toEqual({
      inputTokens: 10,
      outputTokens: 5,
    });
  });

  it("rejects an unknown turn-error category", () => {
    expect(() => decodeTurnError({ message: "x", category: "nope" })).toThrow(/Expected/);
  });
});
