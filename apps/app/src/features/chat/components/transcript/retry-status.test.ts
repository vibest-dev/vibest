import type { TurnRetryState } from "@vibest/contract";
import { describe, expect, it } from "vitest";

import { retryCountdownSeconds, retryStatusText } from "./retry-countdown";

const retry: TurnRetryState = {
  turnId: "turn-1",
  retryNumber: 1,
  maxRetries: 3,
  nextAttemptAt: 10_000,
};

describe("retryStatusText", () => {
  it("counts down to the next retry and keeps retrying visible after zero", () => {
    expect(retryCountdownSeconds(retry.nextAttemptAt, 5_001)).toBe(5);
    expect(retryStatusText(retry, 5_001)).toBe("Retrying 1/3 in 5s…");
    expect(retryStatusText(retry, 10_000)).toBe("Retrying 1/3…");
    expect(retryStatusText(retry, 20_000)).toBe("Retrying 1/3…");
  });
});
