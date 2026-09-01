// @vitest-environment jsdom
// Tiptap builds its document through `elementFromString`, so these need a DOM;
// the rest of this package's tests are node-env, hence the per-file override.
import { describe, expect, it, vi } from "vitest";

import { ChatInputController } from "./chat-input-controller";
import { createChatBaseExtensions } from "./extensions/chat-base-extensions";

const makeController = () =>
  new ChatInputController({
    extensions: () => createChatBaseExtensions(),
    onSubmit: () => {},
  });

describe("ChatInputController", () => {
  it("reports content on the same threshold submit() uses", () => {
    const controller = makeController();

    expect(controller.hasContent()).toBe(false);

    controller.editor.commands.setContent("<p>   </p>");
    expect(controller.hasContent()).toBe(false);

    controller.editor.commands.setContent("<p>hi</p>");
    expect(controller.hasContent()).toBe(true);
    expect(controller.getText()).toBe("hi");

    controller.dispose();
  });

  it("notifies subscribers on edits and stops on unsubscribe", () => {
    const controller = makeController();
    const listener = vi.fn<() => void>();
    const unsubscribe = controller.onChange(listener);

    controller.editor.commands.setContent("<p>hi</p>");
    expect(listener).toHaveBeenCalled();

    unsubscribe();
    listener.mockClear();
    controller.editor.commands.setContent("<p>bye</p>");
    expect(listener).not.toHaveBeenCalled();

    controller.dispose();
  });

  // The state React hands the committed `useSyncExternalStore` snapshot when a
  // route match suspends: the controller store's unsubscribe has already disposed
  // this instance, but the last committed render still closes over it. Reading
  // the destroyed editor is what threw `Cannot read properties of null
  // (reading 'extensions')` — `Editor.destroy()` nulls `extensionManager`, and
  // serialization walks it first.
  it("answers false instead of throwing once disposed", () => {
    const controller = makeController();
    controller.editor.commands.setContent("<p>hi</p>");
    expect(controller.hasContent()).toBe(true);

    controller.dispose();

    expect(() => controller.hasContent()).not.toThrow();
    expect(controller.hasContent()).toBe(false);
  });
});
