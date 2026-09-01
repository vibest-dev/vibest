// @vitest-environment jsdom
// Plain `.ts` + createElement on purpose: apps/app's vitest config carries no
// JSX transform, and one element isn't worth adding a babel pass to every test.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { ChatInputController } from "./chat-input-controller";
import { createChatBaseExtensions } from "./extensions/chat-base-extensions";
import { useChatInputHasContent } from "./use-chat-input-has-content";

// What `act` checks for before it will flush React work.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const makeController = (html?: string) => {
  const controller = new ChatInputController({
    extensions: () => createChatBaseExtensions(),
    onSubmit: () => {},
  });
  if (html) controller.editor.commands.setContent(html);
  return controller;
};

function Probe({ controller }: { controller: ChatInputController | null }) {
  return createElement("span", null, String(useChatInputHasContent(controller)));
}

let root: Root | undefined;
let host: HTMLDivElement | undefined;

const render = (controller: ChatInputController | null): string => {
  if (!host) {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  }
  const mounted = root;
  act(() => mounted?.render(createElement(Probe, { controller })));
  return host.textContent ?? "";
};

afterEach(() => {
  const mounted = root;
  act(() => mounted?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
});

describe("useChatInputHasContent", () => {
  it("starts false while the controller is still being created", () => {
    expect(render(null)).toBe("false");
  });

  it("tracks edits on the mounted controller", () => {
    const controller = makeController();
    expect(render(controller)).toBe("false");

    act(() => {
      controller.editor.commands.setContent("<p>hi</p>");
    });
    expect(host?.textContent).toBe("true");

    act(() => {
      controller.editor.commands.clearContent();
    });
    expect(host?.textContent).toBe("false");

    controller.dispose();
  });

  // The session-switch window: React tears the controller store subscription
  // down and back up while this component stays mounted (a route match
  // suspending on its loader, StrictMode, <Activity>), so one editor is destroyed and another
  // built between two renders of the same fiber. Both halves have to hold —
  // rendering the outgoing, already-disposed controller must not throw, and the
  // incoming one must be read immediately rather than waiting for its first
  // transaction. `useEditorState` failed both: its cached snapshot still
  // pointed at the destroyed editor.
  it("survives the disposed outgoing controller and reads the incoming one at once", () => {
    const outgoing = makeController("<p>typed before switching</p>");
    expect(render(outgoing)).toBe("true");

    outgoing.dispose();
    expect(() => render(outgoing)).not.toThrow();
    expect(host?.textContent).toBe("false");

    const incoming = makeController("<p>restored draft</p>");
    expect(render(incoming)).toBe("true");

    incoming.dispose();
  });
});
