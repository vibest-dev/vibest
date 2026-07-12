import { describe, expect, it } from "vitest";
import { defineEvent, isSessionEvent, SessionEventDefs } from "../src";
import { foldToUIMessages, toSessionEvent, transform } from "../src/claude-code";

describe("public exports", () => {
  it("re-exports the core abstraction from the package root", () => {
    expect(typeof defineEvent).toBe("function");
    expect(typeof isSessionEvent).toBe("function");
    expect(SessionEventDefs.length).toBeGreaterThan(0);
  });

  it("re-exports the claude-code transform/fold surface", () => {
    expect(typeof transform).toBe("function");
    expect(typeof toSessionEvent).toBe("function");
    expect(typeof foldToUIMessages).toBe("function");
  });
});
