import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { makeSessionId, parseSessionId } from "../src/index";

describe("session id", () => {
  it("makeSessionId encodes the harness agent id as a prefix", () => {
    const id = makeSessionId("claude-code");
    expect(id.startsWith("claude-code:")).toBe(true);
  });

  it("parseSessionId round-trips a valid id", async () => {
    const id = makeSessionId("codex");
    const parsed = await Effect.runPromise(parseSessionId(id));
    expect(parsed.harnessAgentId).toBe("codex");
    expect(parsed.uuid).toBe(id.slice("codex:".length));
  });

  it("parseSessionId rejects a missing prefix", async () => {
    const err = await Effect.runPromise(Effect.flip(parseSessionId("bogus")));
    expect(err._tag).toBe("InvalidSessionId");
  });

  it("parseSessionId rejects an unknown harness agent prefix", async () => {
    const err = await Effect.runPromise(Effect.flip(parseSessionId("unknown:123")));
    expect(err._tag).toBe("InvalidSessionId");
  });
});
