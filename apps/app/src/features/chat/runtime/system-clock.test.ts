import { afterEach, describe, expect, it, vi } from "vitest";

import { systemClock } from "./system-clock";

afterEach(() => vi.useRealTimers());

describe("systemClock", () => {
  it("ticks only while it has subscribers", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const listener = vi.fn<() => void>();
    const unsubscribe = systemClock.subscribe(listener);

    expect(systemClock.getSnapshot()).toBe(1_000);
    expect(listener).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1_000);
    expect(systemClock.getSnapshot()).toBe(2_000);
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    vi.advanceTimersByTime(1_000);
    expect(systemClock.getSnapshot()).toBe(2_000);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
