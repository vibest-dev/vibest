import { useCallback, useSyncExternalStore } from "react";

import type { ChatInputController } from "./chat-input-controller";

const NO_UNSUBSCRIBE = () => {};

/**
 * Whether the composer holds something submittable — subscribed to the
 * controller, not to a Tiptap editor.
 *
 * Not `useEditorState`: its `EditorStateManager` caches the last snapshot and
 * refreshes it only when its own transaction counter moves. Swapping the
 * `editor` prop updates the manager's field but leaves the cached snapshot
 * pointing at the *previous* instance, so the selector keeps being handed an
 * editor the controller has already destroyed — and `Editor.destroy()` nulls
 * `extensionManager`, which is the first thing serialization reads.
 *
 * That swap is not exotic: React tears the controller store subscription down
 * and back up while this component stays mounted (a route match suspending on
 * its loader, StrictMode, `<Activity>`), so `useChatInputController` disposes
 * one editor and builds another between two renders of the same fiber. Reading through
 * the controller keeps that impossible — there is no editor reference held
 * across the swap — and it also drops the staleness the cache caused, where
 * the send button reflected the old editor until the new one first changed.
 */
export function useChatInputHasContent(controller: ChatInputController | null): boolean {
  return useSyncExternalStore(
    useCallback(
      (onStoreChange: () => void) => controller?.onChange(onStoreChange) ?? NO_UNSUBSCRIBE,
      [controller],
    ),
    useCallback(() => controller?.hasContent() ?? false, [controller]),
  );
}
