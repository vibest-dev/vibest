import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";

import { AgentRequestSchema, AgentResponseSchema } from "../../src/types/request";

const decodeAgentRequest = Schema.decodeUnknownSync(AgentRequestSchema);
const decodeAgentResponse = Schema.decodeUnknownSync(AgentResponseSchema);

describe("AgentRequest", () => {
  it("parses a tool request", () => {
    const req = {
      type: "tool",
      id: "r1",
      harnessAgentId: "claude-code",
      toolName: "Bash",
      input: { command: "ls" },
      actions: [{ id: "allow", label: "Allow", behavior: "allow" }],
      native: { any: "thing" },
    };
    expect(decodeAgentRequest(req).type).toBe("tool");
  });

  it("rejects a request with an unknown discriminant", () => {
    expect(() => decodeAgentRequest({ type: "mystery", id: "x" })).toThrow(/Expected/);
  });
});

describe("AgentResponse", () => {
  it("parses a tool allow/deny response", () => {
    expect(decodeAgentResponse({ type: "tool", behavior: "allow" }).type).toBe("tool");
    expect(() => decodeAgentResponse({ type: "tool", behavior: "maybe" })).toThrow(/Expected/);
  });
});
