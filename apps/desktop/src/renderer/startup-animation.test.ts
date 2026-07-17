import { afterEach, describe, expect, it, vi } from "vitest";

import { STARTUP_ANIMATION_MS, waitForStartupAnimation } from "./startup-animation";

afterEach(() => {
  vi.useRealTimers();
});

describe("waitForStartupAnimation", () => {
  it("keeps a fast startup visible until the animation completes", async () => {
    vi.useFakeTimers();
    let completed = false;
    const animation = waitForStartupAnimation(false).then(() => {
      completed = true;
    });

    await vi.advanceTimersByTimeAsync(STARTUP_ANIMATION_MS - 1);
    expect(completed).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await animation;
    expect(completed).toBe(true);
  });

  it("does not delay users who prefer reduced motion", async () => {
    await expect(waitForStartupAnimation(true)).resolves.toBeUndefined();
  });
});
