import { describe, expect, it } from "vitest";

import { formatReadyLine, parseReadyLine, READY_PREFIX } from "./handshake";

describe("ready line", () => {
  it("round-trips the bound port", () => {
    const line = formatReadyLine({ port: 41234 });
    expect(parseReadyLine(line)).toEqual({ port: 41234 });
  });

  it("is prefixed so it can be picked out of ordinary stdout", () => {
    expect(formatReadyLine({ port: 1 }).startsWith(READY_PREFIX)).toBe(true);
  });

  it("ignores an unrelated log line", () => {
    expect(parseReadyLine("vibest listening on http://127.0.0.1:4000")).toBeNull();
  });

  it("ignores a prefixed line with unparseable JSON", () => {
    expect(parseReadyLine(`${READY_PREFIX}not-json`)).toBeNull();
  });

  it("ignores a prefixed line with no numeric port", () => {
    expect(parseReadyLine(`${READY_PREFIX}{"port":"nope"}`)).toBeNull();
  });
});
