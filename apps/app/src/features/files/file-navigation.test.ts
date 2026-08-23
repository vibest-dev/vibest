import { describe, expect, it, vi } from "vitest";

import { createFileNavigationTracker } from "./file-navigation";

describe("file navigation tracker", () => {
  it("versions every explicit line request, including identical reopens", () => {
    const tracker = createFileNavigationTracker();
    const listener = vi.fn<() => void>();
    tracker.subscribe(listener);

    tracker.request({ line: 42 });
    tracker.request({ line: 42 });

    expect(tracker.getSnapshot()).toBe(2);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("does not version ordinary file activation and releases listeners", () => {
    const tracker = createFileNavigationTracker();
    const listener = vi.fn<() => void>();
    tracker.subscribe(listener);

    tracker.request({});
    tracker.dispose();
    tracker.request({ line: 7 });

    expect(tracker.getSnapshot()).toBe(1);
    expect(listener).not.toHaveBeenCalled();
  });
});
