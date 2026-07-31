import { describe, expect, it } from "vitest";

import { isSessionEvent } from "../../../src/harness/events/framework";

describe("isSessionEvent", () => {
  it("routes dotted event types to the control plane", () => {
    for (const type of [
      "session.turn.started",
      "session.turn.ended",
      "session.request.asked",
      "project.updated",
      "server.connected",
    ]) {
      expect(isSessionEvent({ type } as never)).toBe(true);
    }
  });

  it("routes AI-SDK chunk types to the render plane", () => {
    for (const type of [
      "start",
      "finish",
      "text-start",
      "text-delta",
      "text-end",
      "tool-input-start",
      "tool-input-available",
      "tool-output-available",
      "tool-output-error",
      "data-custom",
      "reasoning-delta",
    ]) {
      expect(isSessionEvent({ type } as never)).toBe(false);
    }
  });
});
