import { describe, expect, it } from "vitest";

import { retryNoticeFrom } from "./retry-notice";

describe("retryNoticeFrom", () => {
  it("rewrites a provider connection failure", () => {
    expect(
      retryNoticeFrom({
        type: "data-retry",
        transient: true,
        data: { errorMessage: "Connection error." },
      }),
    ).toBe("Couldn't reach the model provider. Retrying…");
  });

  it("includes attempt counts when Pi reports them", () => {
    expect(
      retryNoticeFrom({
        type: "data-retry",
        transient: true,
        data: { errorMessage: "overloaded", attempt: 1, maxAttempts: 3 },
      }),
    ).toBe("overloaded. Retrying (1/3)…");
  });

  it("ignores non-retry chunks", () => {
    expect(retryNoticeFrom({ type: "error", errorText: "boom" })).toBeUndefined();
  });
});
