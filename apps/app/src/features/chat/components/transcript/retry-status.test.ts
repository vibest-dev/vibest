import type { TurnRetryState } from "@vibest/contract";
import { describe, expect, it } from "vitest";

import { retryCountdownSeconds, retryStatusText } from "./retry-countdown";

const retry: TurnRetryState = {
  attempt: 1,
  maxAttempts: 3,
  retryAt: 10_000,
};

describe("retryStatusText", () => {
  it("counts down to the next retry and keeps retrying visible after zero", () => {
    expect(retryCountdownSeconds(retry.retryAt, 5_001)).toBe(5);
    expect(retryStatusText(retry, 5_001)).toBe("Retrying 1/3 in 5s…");
    expect(retryStatusText(retry, 10_000)).toBe("Retrying 1/3…");
    expect(retryStatusText(retry, 20_000)).toBe("Retrying 1/3…");
  });
});
