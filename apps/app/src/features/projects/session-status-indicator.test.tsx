// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { SessionStatusIndicator } from "./session-status-indicator";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

const renderIndicator = (phase: Parameters<typeof SessionStatusIndicator>[0]["phase"]) => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(createElement(SessionStatusIndicator, { phase }));
  });
  return container;
};

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

describe("SessionStatusIndicator", () => {
  it("shows an accessible spinner while running", () => {
    const node = renderIndicator("running");
    const slot = node.querySelector<HTMLSpanElement>("[data-slot=session-status]");
    const loader = node.querySelector("[role=status]");
    expect(slot?.dataset.state).toBe("loading");
    expect(slot?.getAttribute("title")).toBe("A turn is running in this session");
    expect(loader).not.toBeNull();
    expect(loader?.getAttribute("aria-label")).toBe("A turn is running in this session");
  });

  it("shows an accessible amber dot while waiting for user action", () => {
    const node = renderIndicator("requires_action");
    const slot = node.querySelector<HTMLSpanElement>("[data-slot=session-status]");
    const dot = slot?.querySelector<HTMLSpanElement>("span");
    expect(slot?.getAttribute("role")).toBe("img");
    expect(slot?.getAttribute("aria-label")).toBe("Waiting for your action");
    expect(slot?.getAttribute("title")).toBe("Waiting for your action");
    expect(dot?.className).toContain("bg-warning");
    expect(dot?.getAttribute("aria-hidden")).toBe("true");
  });

  it("shows an accessible amber dot when recovery is required", () => {
    const node = renderIndicator("recovery_required");
    const slot = node.querySelector<HTMLSpanElement>("[data-slot=session-status]");
    const dot = slot?.querySelector<HTMLSpanElement>("span");
    expect(slot?.getAttribute("role")).toBe("img");
    expect(slot?.getAttribute("aria-label")).toBe("This session needs recovery");
    expect(slot?.getAttribute("title")).toBe("This session needs recovery");
    expect(dot?.className).toContain("bg-warning");
    expect(dot?.getAttribute("aria-hidden")).toBe("true");
  });

  it("shows an accessible red dot when the session crashed", () => {
    const node = renderIndicator("crashed");
    const slot = node.querySelector<HTMLSpanElement>("[data-slot=session-status]");
    const dot = slot?.querySelector<HTMLSpanElement>("span");
    expect(slot?.getAttribute("role")).toBe("img");
    expect(slot?.getAttribute("aria-label")).toBe("Session crashed");
    expect(slot?.getAttribute("title")).toBe("Session crashed");
    expect(dot?.className).toContain("bg-destructive");
    expect(dot?.getAttribute("aria-hidden")).toBe("true");
  });

  it("reserves a fixed slot for idle or missing status", () => {
    for (const phase of ["idle", undefined] as const) {
      const node = renderIndicator(phase);
      const slot = node.querySelector("span");
      expect(slot?.className).toContain("size-[1em]");
      expect(slot?.className).toContain("shrink-0");
      expect(slot?.querySelector("span")).toBeNull();
    }
  });
});
