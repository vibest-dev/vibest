import type { SessionRef } from "@vibest/contract";
import { describe, expect, it } from "vitest";

import { sameSessionRef, sessionRefKey } from "./session-ref";

const ref = (overrides: Partial<SessionRef> = {}): SessionRef => ({
  projectId: "11111111-1111-4111-8111-111111111111",
  harnessAgentId: "pi",
  sessionId: "shared-session-id",
  ...overrides,
});

describe("SessionRef identity", () => {
  it("compares every field", () => {
    expect(sameSessionRef(ref(), ref())).toBe(true);
    expect(sameSessionRef(ref(), ref({ projectId: "22222222-2222-4222-8222-222222222222" }))).toBe(
      false,
    );
    expect(sameSessionRef(ref(), ref({ harnessAgentId: "codex" }))).toBe(false);
    expect(sameSessionRef(ref(), null)).toBe(false);
  });

  it("keys equal refs together and same-id refs from different projects apart", () => {
    expect(sessionRefKey(ref())).toBe(sessionRefKey(ref()));
    expect(sessionRefKey(ref())).not.toBe(
      sessionRefKey(ref({ projectId: "22222222-2222-4222-8222-222222222222" })),
    );
  });
});
