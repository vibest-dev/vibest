// @vitest-environment jsdom
import { act, createElement, Fragment, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { useRelocatablePortal } from "./use-relocatable-portal";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Counter() {
  const [count, setCount] = useState(0);
  return createElement("button", { onClick: () => setCount((value) => value + 1) }, String(count));
}

function Harness({ mobile }: { mobile: boolean }) {
  const counter = useRelocatablePortal(createElement(Counter), {
    hostClassName: "portal-host",
    key: "counter",
  });
  const target = mobile
    ? createElement("div", { "data-layout": "mobile", ref: counter.mount })
    : createElement(
        "section",
        { "data-layout": "desktop" },
        createElement("div", { ref: counter.mount }),
      );
  return createElement(Fragment, null, counter.portal, target);
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function render(mobile: boolean): HTMLButtonElement {
  if (!container) {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  }
  act(() => root?.render(createElement(Harness, { mobile })));
  const button = container.querySelector("button");
  if (!(button instanceof HTMLButtonElement)) throw new Error("Counter button did not render");
  return button;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

describe("useRelocatablePortal", () => {
  it("preserves its subtree while moving between layout hosts", () => {
    const mobileButton = render(true);
    act(() => mobileButton.click());
    expect(mobileButton.textContent).toBe("1");
    expect(mobileButton.closest("[data-layout]")?.getAttribute("data-layout")).toBe("mobile");
    mobileButton.focus();
    expect(document.activeElement).toBe(mobileButton);

    const desktopButton = render(false);
    expect(desktopButton).toBe(mobileButton);
    expect(desktopButton.textContent).toBe("1");
    expect(desktopButton.closest("[data-layout]")?.getAttribute("data-layout")).toBe("desktop");
    expect(document.activeElement).toBe(desktopButton);
  });
});
