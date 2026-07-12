import { describe, expect, it } from "vitest";
import { AgentRequestSchema, AgentResponseSchema } from "../../src/types/request";

describe("AgentRequest", () => {
  it("parses a tool request", () => {
    const req = {
      type: "tool",
      id: "r1",
      harnessAgentId: "claude-code",
      toolName: "Bash",
      input: { command: "ls" },
      actions: [{ id: "allow", label: "Allow" }],
      native: { any: "thing" },
    };
    expect(AgentRequestSchema.parse(req).type).toBe("tool");
  });

  it("rejects a request with an unknown discriminant", () => {
    expect(() => AgentRequestSchema.parse({ type: "mystery", id: "x" })).toThrow();
  });
});

describe("AgentResponse", () => {
  it("parses a tool allow/deny response", () => {
    expect(AgentResponseSchema.parse({ type: "tool", behavior: "allow" }).type).toBe("tool");
    expect(() => AgentResponseSchema.parse({ type: "tool", behavior: "maybe" })).toThrow();
  });
});
