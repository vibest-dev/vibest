import { describe, expect, it } from "vitest";
import { GlobalEventDefs, SessionEventDefs } from "../src/event-manifest";

const RESERVED_VERBS = new Set([
  "created",
  "updated",
  "deleted",
  "renamed",
  "started",
  "ended",
  "asked",
  "replied",
  "rejected",
  "crashed",
  "failed",
  "exited",
  "connected",
  "disconnected",
]);

describe("event manifest naming invariant", () => {
  const all = [...SessionEventDefs, ...GlobalEventDefs];

  it("every event type is dotted namespace.action", () => {
    for (const def of all) expect(def.type).toContain(".");
  });

  it("every event type ends in a reserved past-tense verb", () => {
    for (const def of all) {
      const verb = def.type.split(".").at(-1);
      expect(RESERVED_VERBS.has(verb ?? "")).toBe(true);
    }
  });

  it("every event type is unique", () => {
    const types = all.map((d) => d.type);
    expect(new Set(types).size).toBe(types.length);
  });

  it("includes the v1 session-scoped catalog", () => {
    const types = SessionEventDefs.map((d) => d.type);
    expect(types).toContain("session.turn.started");
    expect(types).toContain("session.turn.ended");
    expect(types).toContain("session.request.asked");
    expect(types).toContain("session.crashed");
  });
});
