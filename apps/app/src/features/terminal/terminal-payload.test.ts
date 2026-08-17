import { describe, expect, it } from "vitest";

import { parseTerminalPayload, terminalPanelKey } from "./terminal-payload";

describe("terminal payload", () => {
  it("parses a stored record and keys the family by terminalId", () => {
    const payload = parseTerminalPayload({
      terminalId: "term-1",
      title: "bash abcd",
      ptyId: "pty-1",
    });
    expect(payload).toEqual({ terminalId: "term-1", title: "bash abcd", ptyId: "pty-1" });
    expect(terminalPanelKey(payload!)).toBe("term-1");
  });

  it("rejects a missing terminalId and fills a default title", () => {
    expect(parseTerminalPayload({ title: "zsh" })).toBeNull();
    expect(parseTerminalPayload({ terminalId: "term-2" })).toEqual({
      terminalId: "term-2",
      title: "Terminal",
    });
  });
});
