import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { Extension } from "@tiptap/react";

// Composable keymap: one behavior per extension. Future Tab/Shift+Tab/cmdEnter
// behaviors are added as new extensions — this one doesn't change.
export function createSubmitKeymap(opts: {
  onSubmit: () => void;
  // Lets Enter yield to certain states (e.g. an open suggestion menu consumes
  // Enter to select). "When to yield" is injected by the consumer — the core
  // keymap knows no menus and queries no global DOM.
  shouldYield?: (view: EditorView) => boolean;
}) {
  return Extension.create({
    name: "chatSubmitKeymap",
    addProseMirrorPlugins() {
      return [
        new Plugin({
          key: new PluginKey("chatSubmitKeymap"),
          props: {
            handleKeyDown(view, event) {
              if (
                event.key !== "Enter" ||
                event.shiftKey ||
                event.altKey ||
                event.metaKey ||
                event.ctrlKey
              ) {
                return false;
              }
              // Enter during IME composition confirms the candidate — not a send.
              if (event.isComposing) return false;
              if (opts.shouldYield?.(view)) return false;
              event.preventDefault();
              opts.onSubmit();
              return true;
            },
          },
        }),
      ];
    },
  });
}
